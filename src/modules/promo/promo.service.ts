import { db } from "../../db/client"
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import type { PaginationQuery } from "../../shared/pagination"
import { page } from "../../shared/pagination"
import { auditService } from "../audit/audit.service"
import { billingService } from "../billing/billing.service"
import { promoRepository } from "./promo.repository"
import type { PromoCodeRow } from "./promo.repository"
import type { CreatePromoCodeInput } from "./promo.dto"

const DAY_MS = 24 * 60 * 60 * 1000

export type PromoStatus = "active" | "inactive" | "expired" | "exhausted"

/**
 * Four states, derived rather than stored: a code becomes expired or exhausted
 * on its own, and a column saying otherwise would need a job to keep it true.
 * Order matters — inactive wins, because an administrator switching a code off
 * should see that reflected whatever its dates say.
 */
function statusOf(row: PromoCodeRow, now = new Date()): PromoStatus {
	if (!row.active) return "inactive"
	if (row.expiresAt.getTime() <= now.getTime()) return "expired"
	if (row.maxRedemptions !== null && row.redeemedCount >= row.maxRedemptions) {
		return "exhausted"
	}
	return "active"
}

interface Actor {
	name: string | null
	email: string | null
}

function serialize(row: PromoCodeRow, createdBy?: Actor, updatedBy?: Actor) {
	return {
		id: row.id,
		code: row.code,
		credits: Number(row.credits),
		bucket: row.bucket as "plan" | "topup",
		expiresAt: row.expiresAt,
		maxRedemptions: row.maxRedemptions,
		redeemedCount: row.redeemedCount,
		active: row.active,
		status: statusOf(row),
		createdAt: row.createdAt,
		createdBy: createdBy?.email ? createdBy : null,
		updatedAt: row.updatedAt,
		updatedBy: updatedBy?.email ? updatedBy : null,
	}
}

export const promoService = {
	async list(search: string | undefined, query: PaginationQuery) {
		const { items, total } = await promoRepository.list(search, query)
		return page(
			items.map((row) =>
				serialize(
					row.code,
					{ name: row.createdByName, email: row.createdByEmail },
					{ name: row.updatedByName, email: row.updatedByEmail },
				),
			),
			total,
			query,
		)
	},

	async create(input: CreatePromoCodeInput, actorId: string) {
		const expiresAt = input.expiresAt
			? new Date(input.expiresAt)
			: new Date(Date.now() + (input.expiresInDays ?? 0) * DAY_MS)

		if (expiresAt.getTime() <= Date.now()) {
			throw new ValidationError("The expiry date is in the past.", { expiresAt })
		}

		const existing = await promoRepository.findByCode(input.code)
		if (existing) {
			throw new ConflictError(`The code ${input.code} already exists.`, {
				code: input.code,
			})
		}

		const row = await promoRepository.insert({
			id: newId(),
			code: input.code,
			credits: input.credits.toFixed(4),
			bucket: input.bucket,
			expiresAt,
			maxRedemptions: input.maxRedemptions,
			createdBy: actorId,
		})
		if (!row) throw new ConflictError("The promo code could not be created.")

		await auditService.record({
			action: "promo.code.created",
			actorId,
			targetType: "promo_code",
			targetId: row.id,
			metadata: {
				code: row.code,
				credits: input.credits,
				bucket: input.bucket,
				expiresAt,
				maxRedemptions: input.maxRedemptions,
			},
		})

		return serialize(row)
	},

	async setActive(promoCodeId: string, active: boolean, actorId: string) {
		const row = await promoRepository.update(promoCodeId, {
			active,
			updatedAt: new Date(),
			updatedBy: actorId,
		})
		if (!row) throw new NotFoundError("Promo code")

		await auditService.record({
			action: active ? "promo.code.activated" : "promo.code.deactivated",
			actorId,
			targetType: "promo_code",
			targetId: row.id,
			metadata: { code: row.code },
		})

		return serialize(row)
	},

	/**
	 * Hard delete, and only for a code nobody used: promo_redemption cascades,
	 * so deleting a redeemed code would erase the record of credits that were
	 * really handed out while the ledger still shows them. Deactivate instead.
	 *
	 * The check and the delete share a transaction with the row locked, so a
	 * redemption arriving between them cannot slip through.
	 */
	async remove(promoCodeId: string, actorId: string) {
		const removed = await db.transaction(async (tx) => {
			const row = await promoRepository.lockById(promoCodeId, tx)
			if (!row) throw new NotFoundError("Promo code")

			if (row.redeemedCount > 0) {
				throw new ConflictError(
					"This code has been redeemed and cannot be deleted. Deactivate it instead.",
					{ redeemedCount: row.redeemedCount },
				)
			}

			await promoRepository.remove(promoCodeId, tx)
			return row
		})

		await auditService.record({
			action: "promo.code.deleted",
			actorId,
			targetType: "promo_code",
			targetId: removed.id,
			metadata: { code: removed.code },
		})

		return { id: removed.id, code: removed.code }
	},

	async listRedemptions(promoCodeId: string, query: PaginationQuery) {
		const row = await promoRepository.findById(promoCodeId)
		if (!row) throw new NotFoundError("Promo code")

		const { items, total } = await promoRepository.listRedemptions(promoCodeId, query)
		return page(
			items.map((item) => ({
				id: item.id,
				credits: Number(item.credits),
				redeemedAt: item.createdAt,
				workspaceId: item.workspaceId,
				workspaceName: item.workspaceName,
				redeemedBy:
					item.userEmail === null
						? null
						: { name: item.userName, email: item.userEmail },
			})),
			total,
			query,
		)
	},

	async listWorkspaceRedemptions(workspaceId: string) {
		const rows = await promoRepository.listRedemptionsForWorkspace(workspaceId)
		return rows.map((row) => ({
			id: row.id,
			code: row.code,
			credits: Number(row.credits),
			redeemedAt: row.createdAt,
		}))
	},

	/**
	 * Redeems a code for one workspace.
	 *
	 * The whole thing is one transaction holding the code's row lock: claiming
	 * the slot, writing the redemption and moving the credits either all commit
	 * or none do. A redemption row without its credits would be unrecoverable —
	 * the unique index would refuse the retry that was meant to fix it.
	 *
	 * Every refusal carries its own code so the customer is told which rule they
	 * hit; answering "invalid code" to all four is how a support ticket is
	 * opened.
	 */
	async redeem(workspaceId: string, code: string, actorId: string) {
		const result = await db.transaction(async (tx) => {
			const promo = await promoRepository.lockByCode(code, tx)
			if (!promo) throw new NotFoundError("Promo code")

			const status = statusOf(promo)
			if (status === "inactive") {
				throw new ConflictError("This code is no longer available.", {
					reason: "PROMO_INACTIVE",
				})
			}
			if (status === "expired") {
				throw new ConflictError("This code has expired.", { reason: "PROMO_EXPIRED" })
			}
			if (status === "exhausted") {
				throw new ConflictError("This code has been fully redeemed.", {
					reason: "PROMO_EXHAUSTED",
				})
			}

			const already = await promoRepository.findRedemption(promo.id, workspaceId, tx)
			if (already) {
				throw new ConflictError("This workspace has already redeemed this code.", {
					reason: "PROMO_ALREADY_REDEEMED",
				})
			}

			const credits = Number(promo.credits)

			await promoRepository.insertRedemption(
				{
					id: newId(),
					codeId: promo.id,
					organizationId: workspaceId,
					userId: actorId,
					credits: promo.credits,
				},
				tx,
			)
			await promoRepository.incrementRedeemedCount(promo.id, tx)

			await billingService.grantWithin(tx, {
				workspaceId,
				amount: credits,
				bucket: promo.bucket as "plan" | "topup",
				kind: "promo",
				reference: `promo:${promo.id}:${workspaceId}`,
				actorId,
				reason: `Promo code ${promo.code}`,
			})

			return { code: promo.code, credits, bucket: promo.bucket as "plan" | "topup" }
		})

		await auditService.record({
			action: "promo.code.redeemed",
			actorId,
			organizationId: workspaceId,
			targetType: "promo_code",
			targetId: result.code,
			metadata: result,
		})

		return result
	},
}
