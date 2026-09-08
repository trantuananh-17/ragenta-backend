import type { PlatformPermissionKey, WorkspacePermissionKey } from "../../auth/permissions"
import { getRedis } from "../../redis/client"
import { ForbiddenError } from "../../shared/errors"
import { logger } from "../../shared/logger"
import type { MembershipRow } from "../workspace/workspace.repository"
import { primarySystemRoleId } from "./primary-role"
import { rbacRepository } from "./rbac.repository"

/**
 * Answers "may this caller do this?" — the only place that question is answered.
 *
 * The permission set is the union of what every role on a membership grants. A
 * second role can therefore only widen access; narrowing is what a `deny`
 * resource grant is for, and that layer sits above this one.
 *
 * **The cache is an optimisation, never an authority.** A permission set is
 * looked up on nearly every authenticated request, so it is worth caching; but a
 * Redis failure falls back to the query rather than to a decision. Rate limiting
 * may fail open because the credit ledger is what caps the money (ADR-045);
 * authorization has no such second line, so it never guesses in either direction.
 */

const CACHE_TTL_SECONDS = 60
const MEMBER_KEY_PREFIX = "perm:member:"
const USER_KEY_PREFIX = "perm:user:"

async function readCache(key: string): Promise<string[] | undefined> {
	try {
		const cached = await getRedis().get(key)
		if (!cached) return undefined
		const parsed: unknown = JSON.parse(cached)
		if (!Array.isArray(parsed)) return undefined
		return parsed.filter((value): value is string => typeof value === "string")
	} catch (error) {
		logger.warn("permission.cache_unavailable", { key, error: String(error) })
		return undefined
	}
}

async function writeCache(key: string, keys: string[]): Promise<void> {
	try {
		await getRedis().set(key, JSON.stringify(keys), "EX", CACHE_TTL_SECONDS)
	} catch (error) {
		logger.warn("permission.cache_unavailable", { key, error: String(error) })
	}
}

async function forget(keys: string[]): Promise<void> {
	if (keys.length === 0) return
	try {
		await getRedis().del(...keys)
	} catch (error) {
		logger.warn("permission.cache_unavailable", { keys, error: String(error) })
	}
}

/**
 * Writes the role a membership's `member.role` implies. False when there is no
 * such membership — a deleted one, or an id from a stale cache key.
 */
async function healFromBetterAuthRole(memberId: string): Promise<boolean> {
	const membership = await rbacRepository.findMemberById(memberId)
	if (!membership) return false

	await rbacRepository.replaceMemberRoles(memberId, [primarySystemRoleId(membership.role)], null)
	logger.info("permission.roles_healed", { memberId, role: membership.role })
	return true
}

export const permissionService = {
	/**
	 * What this membership may do. Cached under the membership id, which already
	 * names one (workspace, user) pair — so a cached set can never be read for the
	 * wrong workspace, which a key composed of two ids could get wrong.
	 */
	async forMember(memberId: string): Promise<Set<string>> {
		const cacheKey = `${MEMBER_KEY_PREFIX}${memberId}`
		const cached = await readCache(cacheKey)
		if (cached) return new Set(cached)

		let keys = await rbacRepository.listMemberPermissions(memberId)

		// A membership with no roles at all has not been through the backfill or
		// any hook — the workspace creator's own row is the ordinary case, because
		// Better Auth writes it inside `createOrganization` and no `afterAddMember`
		// is raised for it. Healing here rather than enumerating which of Better
		// Auth's internal paths create a member means a path added by a future
		// upgrade converges too, instead of silently granting nothing.
		if (keys.length === 0) {
			const healed = await healFromBetterAuthRole(memberId)
			if (healed) keys = await rbacRepository.listMemberPermissions(memberId)
		}

		await writeCache(cacheKey, keys)
		return new Set(keys)
	},

	async forPlatformUser(userId: string): Promise<Set<string>> {
		const cacheKey = `${USER_KEY_PREFIX}${userId}`
		const cached = await readCache(cacheKey)
		if (cached) return new Set(cached)

		const keys = await rbacRepository.listPlatformPermissions(userId)
		await writeCache(cacheKey, keys)
		return new Set(keys)
	},

	async memberHas(memberId: string, key: WorkspacePermissionKey): Promise<boolean> {
		return (await permissionService.forMember(memberId)).has(key)
	},

	/**
	 * The check a domain service makes at the resource boundary.
	 *
	 * Routes carry `requirePermission` as well, and that is on purpose: middleware
	 * protects the HTTP surface, and this protects the operation — which a job, a
	 * flow node or a second route can reach without passing the first
	 * (`.claude/rules/security.md`).
	 */
	async assertMember(membership: MembershipRow, key: WorkspacePermissionKey): Promise<void> {
		if (await permissionService.memberHas(membership.id, key)) return
		throw new ForbiddenError(`This action requires the ${key} permission.`)
	},

	async assertPlatform(userId: string, key: PlatformPermissionKey): Promise<void> {
		if ((await permissionService.forPlatformUser(userId)).has(key)) return
		throw new ForbiddenError(`This action requires the ${key} permission.`)
	},

	/** Drops a membership's cached set. Called whenever its roles change. */
	async invalidateMember(memberId: string): Promise<void> {
		await forget([`${MEMBER_KEY_PREFIX}${memberId}`])
	},

	async invalidatePlatformUser(userId: string): Promise<void> {
		await forget([`${USER_KEY_PREFIX}${userId}`])
	},

	/**
	 * Drops every cached set.
	 *
	 * Editing a role changes what an unknown number of memberships may do, and
	 * finding them all is a join that would have to be kept correct as the model
	 * grows. Role edits are rare and administrator-driven; a full flush costs one
	 * uncached query per active member for the next minute, which is the cheaper
	 * mistake to make.
	 */
	async invalidateAll(): Promise<void> {
		try {
			const redis = getRedis()
			const stream = redis.scanStream({ match: "perm:*", count: 200 })
			for await (const batch of stream) {
				const keys = batch as string[]
				if (keys.length > 0) await redis.unlink(...keys)
			}
		} catch (error) {
			logger.warn("permission.cache_unavailable", { scope: "all", error: String(error) })
		}
	},

	/**
	 * Puts a membership's roles in step with the role string Better Auth wrote.
	 *
	 * Better Auth owns `member.role` and resolves its own membership operations
	 * through it, inside its handlers, before any Ragenta code runs. So the
	 * direction of truth for *those* endpoints is Better Auth → us, and this runs
	 * from its `afterAddMember` and `afterUpdateMemberRole` hooks. Without it, a
	 * role changed through the members screen would leave the person's permissions
	 * on their previous role — visible nowhere, and wrong until the next deploy's
	 * backfill.
	 *
	 * A role string naming nothing Ragenta ships becomes `member`, the least
	 * privileged role that can still use the product.
	 */
	async syncFromBetterAuthRole(memberId: string, roleString: string): Promise<void> {
		await rbacRepository.replaceMemberRoles(memberId, [primarySystemRoleId(roleString)], null)
		await permissionService.invalidateMember(memberId)
	},

	/**
	 * What the caller may do here, for the caller's own UI.
	 *
	 * The frontends decide what to render from the role string today, which means
	 * every capability rule exists twice and the copy in `lib/workspace.ts` is a
	 * guess about what the backend will allow. Serving the resolved set lets that
	 * guess be replaced by the answer. It stays affordance only — the backend
	 * decides (`.claude/rules/security.md`).
	 */
	async describeForMember(memberId: string) {
		const [permissions, roles] = await Promise.all([
			permissionService.forMember(memberId),
			rbacRepository.listMemberRoles(memberId),
		])
		return {
			permissions: [...permissions].sort(),
			roles: roles.map((role) => ({ key: role.key, name: role.name })),
		}
	},
}
