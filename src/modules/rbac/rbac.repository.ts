import { and, eq, inArray, or } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import {
	member,
	memberRole,
	permission,
	resourceGrant,
	role,
	rolePermission,
	userPlatformRole,
} from "../../db/schema"

import type { GrantEffect } from "./grant-decision"

export type RoleRow = typeof role.$inferSelect
export type PermissionRow = typeof permission.$inferSelect

/**
 * Every read is scoped by the identifier it is given — a membership id, a user
 * id, a workspace id — and none of them returns another tenant's rows. A
 * membership id already names one (workspace, user) pair, which is what makes it
 * safe to cache a permission set under it.
 */
export const rbacRepository = {
	/** The union of what every role on this membership grants. */
	async listMemberPermissions(memberId: string, executor: DbExecutor = db): Promise<string[]> {
		const rows = await executor
			.selectDistinct({ key: rolePermission.permissionKey })
			.from(memberRole)
			.innerJoin(rolePermission, eq(rolePermission.roleId, memberRole.roleId))
			.where(eq(memberRole.memberId, memberId))
		return rows.map((row) => row.key)
	},

	/** The union of what every platform role on this account grants. */
	async listPlatformPermissions(userId: string, executor: DbExecutor = db): Promise<string[]> {
		const rows = await executor
			.selectDistinct({ key: rolePermission.permissionKey })
			.from(userPlatformRole)
			.innerJoin(rolePermission, eq(rolePermission.roleId, userPlatformRole.roleId))
			.where(eq(userPlatformRole.userId, userId))
		return rows.map((row) => row.key)
	},

	async listMemberRoles(memberId: string, executor: DbExecutor = db): Promise<RoleRow[]> {
		return executor
			.select({
				id: role.id,
				organizationId: role.organizationId,
				scope: role.scope,
				key: role.key,
				name: role.name,
				description: role.description,
				isSystem: role.isSystem,
				createdAt: role.createdAt,
				updatedAt: role.updatedAt,
				createdBy: role.createdBy,
			})
			.from(memberRole)
			.innerJoin(role, eq(role.id, memberRole.roleId))
			.where(eq(memberRole.memberId, memberId))
	},

	async findMemberById(memberId: string, executor: DbExecutor = db) {
		const rows = await executor.select().from(member).where(eq(member.id, memberId)).limit(1)
		return rows[0]
	},

	/** The role ids a membership holds, for composing the subject set of a grant lookup. */
	async listMemberRoleIds(memberId: string, executor: DbExecutor = db): Promise<string[]> {
		const rows = await executor
			.select({ roleId: memberRole.roleId })
			.from(memberRole)
			.where(eq(memberRole.memberId, memberId))
		return rows.map((row) => row.roleId)
	},

	/**
	 * Every grant on one resource that applies to this membership — written
	 * against the person, or against a role they hold.
	 *
	 * The workspace id is in the statement, not applied afterwards: a grant is
	 * addressed by a polymorphic `resource_id` that carries no foreign key, so the
	 * tenant filter is the only thing keeping one workspace's grant from being read
	 * for another's resource of the same id.
	 */
	async listGrantsForResource(
		workspaceId: string,
		memberId: string,
		roleIds: string[],
		resourceType: string,
		resourceId: string,
		permissionKey: string,
		executor: DbExecutor = db,
	): Promise<GrantEffect[]> {
		const subject = roleIds.length
			? or(
					and(eq(resourceGrant.subjectType, "member"), eq(resourceGrant.subjectId, memberId)),
					and(eq(resourceGrant.subjectType, "role"), inArray(resourceGrant.subjectId, roleIds)),
				)
			: and(eq(resourceGrant.subjectType, "member"), eq(resourceGrant.subjectId, memberId))

		const rows = await executor
			.select({ effect: resourceGrant.effect })
			.from(resourceGrant)
			.where(
				and(
					eq(resourceGrant.organizationId, workspaceId),
					eq(resourceGrant.resourceType, resourceType),
					eq(resourceGrant.resourceId, resourceId),
					eq(resourceGrant.permissionKey, permissionKey),
					subject,
				),
			)

		return rows.map((row) => (row.effect === "deny" ? "deny" : "allow"))
	},

	/**
	 * Replaces a membership's roles with exactly this set, in one transaction.
	 *
	 * Delete-then-insert rather than a diff: the set is four rows at most, and a
	 * diff would have to be right about the empty case, which is the one that
	 * silently leaves somebody their old access.
	 */
	async replaceMemberRoles(
		memberId: string,
		roleIds: string[],
		actorId: string | null,
		executor: DbExecutor = db,
	): Promise<void> {
		await executor.transaction(async (tx) => {
			await tx.delete(memberRole).where(eq(memberRole.memberId, memberId))
			if (roleIds.length === 0) return
			await tx
				.insert(memberRole)
				.values(roleIds.map((roleId) => ({ memberId, roleId, createdBy: actorId })))
				.onConflictDoNothing()
		})
	},
}
