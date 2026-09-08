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

	async listPermissionsInScope(scope: "workspace" | "platform", executor: DbExecutor = db) {
		return executor
			.select()
			.from(permission)
			.where(eq(permission.scope, scope))
			.orderBy(permission.key)
	},

	/**
	 * Roles an administrator may see and compose.
	 *
	 * `workspaceId` given: the built-in workspace roles plus that workspace's own.
	 * Omitted: every built-in role in both scopes, which is the console's list.
	 * A role belonging to another workspace is never selected, rather than
	 * selected and filtered — a filter above this layer is one somebody forgets.
	 */
	async listRoles(workspaceId: string | undefined, executor: DbExecutor = db): Promise<RoleRow[]> {
		return executor.query.role.findMany({
			where: (fields, { eq: is, isNull, or }) =>
				workspaceId
					? or(isNull(fields.organizationId), is(fields.organizationId, workspaceId))
					: isNull(fields.organizationId),
			orderBy: (fields, { asc }) => [asc(fields.scope), asc(fields.organizationId), asc(fields.key)],
		})
	},

	async findRoleById(roleId: string, executor: DbExecutor = db): Promise<RoleRow | undefined> {
		const rows = await executor.select().from(role).where(eq(role.id, roleId)).limit(1)
		return rows[0]
	},

	async listRolePermissionKeys(roleId: string, executor: DbExecutor = db): Promise<string[]> {
		const rows = await executor
			.select({ key: rolePermission.permissionKey })
			.from(rolePermission)
			.where(eq(rolePermission.roleId, roleId))
			.orderBy(rolePermission.permissionKey)
		return rows.map((row) => row.key)
	},

	async createRole(
		row: typeof role.$inferInsert,
		permissionKeys: string[],
		executor: DbExecutor = db,
	): Promise<void> {
		await executor.transaction(async (tx) => {
			await tx.insert(role).values(row)
			if (permissionKeys.length === 0) return
			await tx
				.insert(rolePermission)
				.values(permissionKeys.map((key) => ({ roleId: row.id, permissionKey: key })))
		})
	},

	async updateRole(
		roleId: string,
		fields: { name?: string; description?: string },
		permissionKeys: string[] | undefined,
		executor: DbExecutor = db,
	): Promise<void> {
		await executor.transaction(async (tx) => {
			if (Object.keys(fields).length > 0) {
				await tx.update(role).set(fields).where(eq(role.id, roleId))
			}
			if (!permissionKeys) return
			await tx.delete(rolePermission).where(eq(rolePermission.roleId, roleId))
			if (permissionKeys.length === 0) return
			await tx
				.insert(rolePermission)
				.values(permissionKeys.map((key) => ({ roleId, permissionKey: key })))
		})
	},

	async deleteRole(roleId: string, executor: DbExecutor = db): Promise<void> {
		await executor.delete(role).where(eq(role.id, roleId))
	},

	/** How many subjects hold this role, across both kinds of assignment. */
	async countRoleHolders(roleId: string, executor: DbExecutor = db): Promise<number> {
		const [members, users] = await Promise.all([
			executor.select({ id: memberRole.memberId }).from(memberRole).where(eq(memberRole.roleId, roleId)),
			executor
				.select({ id: userPlatformRole.userId })
				.from(userPlatformRole)
				.where(eq(userPlatformRole.roleId, roleId)),
		])
		return members.length + users.length
	},

	async countPlatformRoleHolders(roleId: string, executor: DbExecutor = db): Promise<number> {
		const rows = await executor
			.select({ id: userPlatformRole.userId })
			.from(userPlatformRole)
			.where(eq(userPlatformRole.roleId, roleId))
		return rows.length
	},

	async replacePlatformRoles(
		userId: string,
		roleIds: string[],
		actorId: string | null,
		executor: DbExecutor = db,
	): Promise<void> {
		await executor.transaction(async (tx) => {
			await tx.delete(userPlatformRole).where(eq(userPlatformRole.userId, userId))
			if (roleIds.length === 0) return
			await tx
				.insert(userPlatformRole)
				.values(roleIds.map((roleId) => ({ userId, roleId, createdBy: actorId })))
				.onConflictDoNothing()
		})
	},

	async listPlatformRoles(userId: string, executor: DbExecutor = db): Promise<RoleRow[]> {
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
			.from(userPlatformRole)
			.innerJoin(role, eq(role.id, userPlatformRole.roleId))
			.where(eq(userPlatformRole.userId, userId))
	},

	/**
	 * Swaps the membership's **built-in** role, leaving any custom ones in place.
	 *
	 * Better Auth writes `member.role` and our hook mirrors it here. Replacing the
	 * whole set would mean that changing somebody from `member` to `admin` on the
	 * members screen silently deleted every custom role they held — a data loss
	 * with no message and no way to notice until somebody could not do their job.
	 *
	 * A membership therefore holds exactly one system role plus any number of
	 * custom ones, which is also what makes the members screen's two controls —
	 * a single-choice built-in role and a multi-choice list of the workspace's own
	 * — mean what they appear to mean (ADR-053).
	 */
	async replaceSystemMemberRole(
		memberId: string,
		roleId: string,
		executor: DbExecutor = db,
	): Promise<void> {
		await executor.transaction(async (tx) => {
			await tx
				.delete(memberRole)
				.where(
					and(
						eq(memberRole.memberId, memberId),
						inArray(
							memberRole.roleId,
							tx.select({ id: role.id }).from(role).where(eq(role.isSystem, true)),
						),
					),
				)
			await tx.insert(memberRole).values({ memberId, roleId }).onConflictDoNothing()
		})
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
