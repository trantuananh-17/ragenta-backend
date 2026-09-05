import { db } from "../../db/client"
import type { Transaction } from "../../db/client"
import { EntitlementError, NotFoundError, ValidationError } from "../../shared/errors"
import { monthKey, newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import type { PaginationQuery } from "../../shared/pagination"
import { page } from "../../shared/pagination"
import { auditService } from "../audit/audit.service"
import { workspaceRepository } from "../workspace/workspace.repository"
import { billingRepository } from "./billing.repository"
import {
	ACTIVE_SUBSCRIPTION_STATUSES,
	PLAN_FREE,
	SIGNUP_GRANT_CREDITS,
	creditsForPeriod,
	planLimits,
} from "./plans"
import type { PlanName } from "./plans"

const log = logger.child({ module: "billing" })

/** Ledger amounts are numeric(14,4); keep every write at that exact scale. */
const SCALE = 4

function toNumber(value: string): number {
	return Number(value)
}

function toAmount(value: number): string {
	return value.toFixed(SCALE)
}

/** Start of the next UTC month — when the plan bucket refills again. */
function nextPeriodStart(from: Date): Date {
	return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1))
}

export type CreditSource = "chat" | "embedding" | "ingestion" | "agent" | "admin"

export interface SpendInput {
	workspaceId: string
	amount: number
	/**
	 * Idempotency key for this spend — a job id, a message id, a provider call
	 * id. The same reference never charges twice.
	 */
	reference: string
	source: CreditSource
}

export interface GrantInput {
	workspaceId: string
	amount: number
	bucket: "plan" | "topup"
	kind: "topup" | "admin_adjust" | "refund" | "signup_grant" | "promo"
	reference: string
	actorId?: string
	reason?: string
}

export const billingService = {
	/**
	 * Gives a workspace its billing rows. Idempotent, so it is safe to call on
	 * every workspace creation and again from a repair script.
	 */
	async provisionWorkspace(workspaceId: string): Promise<void> {
		await billingRepository.createBalanceIfMissing(workspaceId)
		await billingRepository.createSubscriptionIfMissing({
			id: newId(),
			organizationId: workspaceId,
			plan: PLAN_FREE,
			status: "active",
			periodStart: new Date(),
			periodEnd: nextPeriodStart(new Date()),
		})

		/**
		 * The trial credits land in the top-up bucket, not the plan bucket: the
		 * plan bucket is reset by every refill, and a one-time grant that a later
		 * upgrade would silently erase is not a grant.
		 */
		await this.grant({
			workspaceId,
			amount: SIGNUP_GRANT_CREDITS,
			bucket: "topup",
			kind: "signup_grant",
			reference: `signup:${workspaceId}`,
			reason: "Signup trial credits",
		})

		// Free grants nothing on a schedule, so this is a no-op until the
		// workspace is on a paid plan.
		await this.refillPlanCredits(workspaceId)
	},

	async getPlan(workspaceId: string): Promise<PlanName> {
		const subscription = await billingRepository.findSubscription(workspaceId)
		if (!subscription) return PLAN_FREE
		const isActive = (ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(
			subscription.status,
		)
		if (!isActive) return PLAN_FREE
		return subscription.plan as PlanName
	},

	async getSummary(workspaceId: string) {
		const [plan, balance, members, pendingInvitations] = await Promise.all([
			this.getPlan(workspaceId),
			billingRepository.findBalance(workspaceId),
			workspaceRepository.countMembers(workspaceId),
			workspaceRepository.countPendingInvitations(workspaceId),
		])
		if (!balance) throw new NotFoundError("Credit balance")

		const limits = planLimits(plan)
		const planCredits = toNumber(balance.planCredits)
		const topupCredits = toNumber(balance.topupCredits)

		return {
			plan,
			limits,
			credits: {
				plan: planCredits,
				topup: topupCredits,
				total: planCredits + topupCredits,
				resetAt: balance.planResetAt,
			},
			seats: {
				used: members + pendingInvitations,
				limit: limits.seatLimit,
			},
		}
	},

	async listTransactions(workspaceId: string, query: PaginationQuery) {
		const { items, total } = await billingRepository.listTransactions(workspaceId, query)
		return page(items, total, query)
	},

	/**
	 * Spends credits, plan bucket first so the perishable balance is used before
	 * purchased credit.
	 *
	 * Idempotency: both ledger rows are keyed on `reference`. If the first insert
	 * hits the unique index the spend already happened and the balance is left
	 * exactly as it is — a retried job never charges twice.
	 */
	async spend(input: SpendInput) {
		return db.transaction((tx) => this.spendWithin(tx, input))
	},

	/**
	 * The spend itself, inside a transaction the caller owns. Usage recording
	 * calls this so the token detail and the credit movement commit together.
	 */
	async spendWithin(tx: Transaction, input: SpendInput) {
		if (!(input.amount > 0)) {
			throw new ValidationError("Spend amount must be greater than zero.")
		}

		const balance = await billingRepository.lockBalance(input.workspaceId, tx)
		if (!balance) throw new NotFoundError("Credit balance")

		const planCredits = toNumber(balance.planCredits)
		const topupCredits = toNumber(balance.topupCredits)

		if (planCredits + topupCredits < input.amount) {
			throw new EntitlementError(
				"INSUFFICIENT_CREDITS",
				"This workspace does not have enough credits for the operation.",
				{ required: input.amount, available: planCredits + topupCredits },
			)
		}

		const fromPlan = Math.min(planCredits, input.amount)
		const fromTopup = input.amount - fromPlan

		if (fromPlan > 0) {
			const inserted = await billingRepository.insertTransaction(
				{
					id: newId(),
					organizationId: input.workspaceId,
					kind: "deduct",
					bucket: "plan",
					amount: toAmount(-fromPlan),
					reference: `${input.reference}#plan`,
					source: input.source,
				},
				tx,
			)
			if (!inserted) {
				log.info("Spend already applied, skipping", {
					workspaceId: input.workspaceId,
					reference: input.reference,
				})
				return { charged: 0, planCredits, topupCredits, alreadyApplied: true }
			}
		}

		if (fromTopup > 0) {
			const inserted = await billingRepository.insertTransaction(
				{
					id: newId(),
					organizationId: input.workspaceId,
					kind: "deduct",
					bucket: "topup",
					amount: toAmount(-fromTopup),
					reference: `${input.reference}#topup`,
					source: input.source,
				},
				tx,
			)
			if (!inserted && fromPlan === 0) {
				return { charged: 0, planCredits, topupCredits, alreadyApplied: true }
			}
		}

		await billingRepository.setBalance(
			input.workspaceId,
			{
				planCredits: toAmount(planCredits - fromPlan),
				topupCredits: toAmount(topupCredits - fromTopup),
			},
			tx,
		)

		return {
			charged: input.amount,
			planCredits: planCredits - fromPlan,
			topupCredits: topupCredits - fromTopup,
			alreadyApplied: false,
		}
	},

	/** Adds credit to one bucket. Audited in the same transaction as the ledger row. */
	async grant(input: GrantInput) {
		return db.transaction((tx) => this.grantWithin(tx, input))
	},

	/**
	 * The grant itself, inside a transaction the caller owns. Promo redemption
	 * uses it so claiming the code and moving the credit commit together — a
	 * redemption row without its credits would be unrecoverable, because the
	 * unique index would then refuse the retry.
	 */
	async grantWithin(tx: Transaction, input: GrantInput) {
		if (!(input.amount > 0)) {
			throw new ValidationError("Grant amount must be greater than zero.")
		}

		const balance = await billingRepository.lockBalance(input.workspaceId, tx)
		if (!balance) throw new NotFoundError("Credit balance")

		const inserted = await billingRepository.insertTransaction(
			{
				id: newId(),
				organizationId: input.workspaceId,
				kind: input.kind,
				bucket: input.bucket,
				amount: toAmount(input.amount),
				reference: input.reference,
				source: input.kind === "admin_adjust" ? "admin" : null,
			},
			tx,
		)

		if (!inserted) {
			return {
				granted: 0,
				alreadyApplied: true,
				planCredits: toNumber(balance.planCredits),
				topupCredits: toNumber(balance.topupCredits),
			}
		}

		const planCredits =
			toNumber(balance.planCredits) + (input.bucket === "plan" ? input.amount : 0)
		const topupCredits =
			toNumber(balance.topupCredits) + (input.bucket === "topup" ? input.amount : 0)

		await billingRepository.setBalance(
			input.workspaceId,
			{ planCredits: toAmount(planCredits), topupCredits: toAmount(topupCredits) },
			tx,
		)

		await auditService.recordWithin(tx, {
			action: "billing.credits.granted",
			actorId: input.actorId ?? null,
			organizationId: input.workspaceId,
			targetType: "credit_balance",
			targetId: input.workspaceId,
			metadata: {
				amount: input.amount,
				bucket: input.bucket,
				kind: input.kind,
				reason: input.reason ?? null,
			},
		})

		return { granted: input.amount, alreadyApplied: false, planCredits, topupCredits }
	},

	/**
	 * Resets the plan bucket for the current period. Plan credits do not roll
	 * over, so this SETS the bucket rather than adding to it.
	 *
	 * Idempotent per period: the ledger reference carries `YYYY-MM`, so however
	 * many times the refill job runs in a month, only the first one posts.
	 */
	async refillPlanCredits(workspaceId: string, at = new Date()) {
		const plan = await this.getPlan(workspaceId)
		const seats = await workspaceRepository.countMembers(workspaceId)
		const amount = creditsForPeriod(plan, seats)

		// Free gets a one-time signup grant instead, and enterprise is granted by
		// hand. Neither has a scheduled refill.
		if (amount === null) {
			return { refilled: false, reason: "plan_has_no_scheduled_refill" as const }
		}

		const reference = `refill:${workspaceId}:${monthKey(at)}`

		return db.transaction(async (tx) => {
			await billingRepository.createBalanceIfMissing(workspaceId, tx)
			const balance = await billingRepository.lockBalance(workspaceId, tx)
			if (!balance) throw new NotFoundError("Credit balance")

			const inserted = await billingRepository.insertTransaction(
				{
					id: newId(),
					organizationId: workspaceId,
					kind: "plan_refill",
					bucket: "plan",
					amount: toAmount(amount),
					reference,
				},
				tx,
			)

			if (!inserted) {
				return { refilled: false, reason: "already_refilled" as const }
			}

			await billingRepository.setBalance(
				workspaceId,
				{ planCredits: toAmount(amount), planResetAt: nextPeriodStart(at) },
				tx,
			)

			return { refilled: true, amount, plan }
		})
	},

	/**
	 * Guards the seat cap before an invitation or a direct add. Pending
	 * invitations count, otherwise a workspace could invite past its plan and
	 * only overflow once everyone accepted.
	 */
	async assertSeatAvailable(workspaceId: string): Promise<void> {
		const plan = await this.getPlan(workspaceId)
		const limit = planLimits(plan).seatLimit
		if (limit === null) return

		const [members, pending] = await Promise.all([
			workspaceRepository.countMembers(workspaceId),
			workspaceRepository.countPendingInvitations(workspaceId),
		])
		const used = members + pending

		if (used >= limit) {
			throw new EntitlementError(
				"SEAT_LIMIT_REACHED",
				`The ${plan} plan allows ${limit} seat${limit === 1 ? "" : "s"}. Upgrade to invite more people.`,
				{ plan, limit, used },
			)
		}
	},

	async changePlan(workspaceId: string, plan: PlanName, actorId: string) {
		const current = await billingRepository.findSubscription(workspaceId)
		if (!current) throw new NotFoundError("Subscription")

		const updated = await billingRepository.updateSubscription(workspaceId, {
			plan,
			status: "active",
		})

		await auditService.record({
			action: "billing.plan.changed",
			actorId,
			organizationId: workspaceId,
			targetType: "subscription",
			targetId: current.id,
			metadata: { from: current.plan, to: plan },
		})

		return updated
	},

	async listWorkspacesDueForRefill(before: Date, limit: number) {
		return billingRepository.listWorkspacesDueForRefill(before, limit)
	},
}
