import { WORKSPACE_PERMISSION_KEYS } from "../../auth/permissions"
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import { auditService } from "../audit/audit.service"
import { billingService } from "../billing/billing.service"
import { permissionService } from "../rbac/permission.service"
import { workspaceRepository } from "../workspace/workspace.repository"
import type { MembershipRow } from "../workspace/workspace.repository"
import { apiKeyRepository } from "./apikey.repository"
import type { ApiKeyRow } from "./apikey.repository"
import { generateKey, hashKey } from "./key-format"
import type { CreateApiKeyInput } from "./apikey.dto"

const log = logger.child({ module: "apikey" })

/** How often a key's `last_used_at` is written, at most. */
const TOUCH_INTERVAL_MS = 60_000

export interface ApiKeyCaller {
	key: ApiKeyRow
	membership: MembershipRow
	/** What this request may actually do — the intersection, already computed. */
	permissions: Set<string>
}

export const apiKeyService = {
	async list(workspaceId: string) {
		return (await apiKeyRepository.list(workspaceId)).map(toPublic)
	},

	/**
	 * Creates a key, returning the plaintext **once**.
	 *
	 * The requested permissions are refused if the creator does not hold them —
	 * not silently trimmed. A key that quietly does less than it was asked for is
	 * one somebody debugs for an afternoon; a refusal names the permission.
	 */
	async create(membership: MembershipRow, input: CreateApiKeyInput, actorId: string) {
		await billingService.assertPlanFeature(membership.organizationId, "apiKeysEnabled")

		const unknown = input.permissions.filter(
			(key) => !(WORKSPACE_PERMISSION_KEYS as readonly string[]).includes(key),
		)
		if (unknown.length > 0) {
			throw new ValidationError(`No such permission: ${unknown.join(", ")}.`)
		}

		const held = await permissionService.forMember(membership.id)
		const missing = input.permissions.filter((key) => !held.has(key))
		if (missing.length > 0) {
			throw new ForbiddenError(
				`You cannot give a key a permission you do not hold: ${missing.join(", ")}.`,
			)
		}

		if (input.permissions.length === 0) {
			// A key with nothing on it authenticates and can do nothing, which reads
			// as the API being broken rather than as the key being empty.
			throw new ValidationError("A key needs at least one permission to be useful.")
		}

		const generated = generateKey()
		const id = newId()

		await apiKeyRepository.insert({
			id,
			organizationId: membership.organizationId,
			name: input.name,
			keyHash: generated.hash,
			keyHint: generated.hint,
			permissions: input.permissions,
			memberId: membership.id,
			expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
			createdBy: actorId,
		})

		await auditService.record({
			action: "apikey.created",
			actorId,
			organizationId: membership.organizationId,
			targetType: "api_key",
			targetId: id,
			metadata: { name: input.name, permissions: input.permissions },
		})

		log.info("apikey.created", { workspaceId: membership.organizationId, keyId: id })

		// The only response that carries it. It is stored hashed and there is
		// nothing to show afterwards, which the screen has to say at this moment.
		return { key: { id, name: input.name, hint: generated.hint }, secret: generated.plaintext }
	},

	async revoke(workspaceId: string, keyId: string, actorId: string) {
		const existing = await apiKeyRepository.findScoped(workspaceId, keyId)
		if (!existing) throw new NotFoundError("API key")
		if (existing.revokedAt) return

		await apiKeyRepository.revoke(keyId)
		await auditService.record({
			action: "apikey.revoked",
			actorId,
			organizationId: workspaceId,
			targetType: "api_key",
			targetId: keyId,
			metadata: { name: existing.name },
		})
	},

	/**
	 * Who a presented key is, and what this request may do.
	 *
	 * The permission set is the **intersection** of what the key was given and
	 * what its membership still holds. That is the property that matters: a key
	 * written by an admin who is later demoted stops being able to do admin
	 * things, without anybody having to remember to revoke it. A credential that
	 * outlives its author's authority is what an audit finds and nobody can
	 * explain.
	 *
	 * A revoked, expired or orphaned key is `undefined`, never an error with a
	 * reason — the caller turns that into one 401, because distinguishing "expired"
	 * from "never existed" tells somebody probing which half they got right.
	 */
	async resolve(plaintext: string): Promise<ApiKeyCaller | undefined> {
		const row = await apiKeyRepository.findByHash(hashKey(plaintext))
		if (!row) return undefined
		if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined

		const membership = await workspaceRepository.findMemberById(
			row.organizationId,
			row.memberId,
		)
		// The membership is gone: whoever created this key is no longer in the
		// workspace, so neither is the key. The cascade would normally have taken
		// the row, and this covers the moment before it did.
		if (!membership) return undefined

		const held = await permissionService.forMember(membership.id)
		const permissions = new Set(row.permissions.filter((key) => held.has(key)))

		if (permissions.size === 0) {
			log.warn("apikey.no_effective_permissions", { keyId: row.id })
			return undefined
		}

		void touchOccasionally(row)
		return { key: row, membership, permissions }
	},
}

/**
 * Records that a key was used, at most once a minute per key.
 *
 * A key called a thousand times a minute should not be a thousand writes to one
 * row — the lock contention would be on the hot path of every API request. The
 * timestamp exists to answer "is this key still in use", which a minute's
 * resolution answers just as well.
 */
const lastTouched = new Map<string, number>()

async function touchOccasionally(row: ApiKeyRow): Promise<void> {
	const now = Date.now()
	const previous = lastTouched.get(row.id) ?? row.lastUsedAt?.getTime() ?? 0
	if (now - previous < TOUCH_INTERVAL_MS) return

	lastTouched.set(row.id, now)
	await apiKeyRepository.touch(row.id).catch((error: unknown) => {
		// Best effort. A request must not fail because a usage timestamp did.
		log.warn("apikey.touch_failed", { keyId: row.id, error: String(error) })
	})
}

/** Never the key. The hint is the only readable part that survives creation. */
function toPublic(row: ApiKeyRow) {
	return {
		id: row.id,
		name: row.name,
		hint: row.keyHint,
		permissions: row.permissions,
		expiresAt: row.expiresAt,
		revokedAt: row.revokedAt,
		lastUsedAt: row.lastUsedAt,
		createdAt: row.createdAt,
		/** Derived rather than stored, so it cannot disagree with the columns. */
		status: row.revokedAt
			? "revoked"
			: row.expiresAt && row.expiresAt.getTime() <= Date.now()
				? "expired"
				: "active",
	}
}

/** Thrown by the middleware, so the one 401 message lives in one place. */
export function unauthorizedKey(): never {
	throw new UnauthorizedError("That API key is not valid.")
}
