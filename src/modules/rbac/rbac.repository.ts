import { eq } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import {
	member,
	memberRole,
	permission,
	role,
	rolePermission,
	userPlatformRole,
} from "../../db/schema"

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
