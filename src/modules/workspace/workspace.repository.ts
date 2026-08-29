import { and, count, desc, eq } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { invitation, member, organization, user } from "../../db/schema"
import type { PaginationQuery } from "../../shared/pagination"

export type WorkspaceRow = typeof organization.$inferSelect
export type MembershipRow = typeof member.$inferSelect

/**
 * Every read here is workspace-scoped in SQL. No method returns rows the caller
 * then has to filter — a forgotten filter above this layer would be a tenant
 * leak, so the boundary does not offer one.
 */
export const workspaceRepository = {
	async findById(workspaceId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(organization)
			.where(eq(organization.id, workspaceId))
			.limit(1)
		return rows[0]
	},

	async findBySlug(slug: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(organization)
			.where(eq(organization.slug, slug))
			.limit(1)
		return rows[0]
	},

	async findMembership(workspaceId: string, userId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(member)
			.where(and(eq(member.organizationId, workspaceId), eq(member.userId, userId)))
			.limit(1)
		return rows[0]
	},

	async findMemberById(workspaceId: string, memberId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(member)
			.where(and(eq(member.organizationId, workspaceId), eq(member.id, memberId)))
			.limit(1)
		return rows[0]
	},

	async listForUser(userId: string, executor: DbExecutor = db) {
		return executor
			.select({
				id: organization.id,
				name: organization.name,
				slug: organization.slug,
				logo: organization.logo,
				createdAt: organization.createdAt,
				role: member.role,
				joinedAt: member.createdAt,
			})
			.from(member)
			.innerJoin(organization, eq(member.organizationId, organization.id))
			.where(eq(member.userId, userId))
			.orderBy(desc(member.createdAt))
	},

	async listMembers(workspaceId: string, query: PaginationQuery, executor: DbExecutor = db) {
		const items = await executor
			.select({
				id: member.id,
				role: member.role,
				createdAt: member.createdAt,
				userId: user.id,
				name: user.name,
				email: user.email,
				image: user.image,
			})
			.from(member)
			.innerJoin(user, eq(member.userId, user.id))
			.where(eq(member.organizationId, workspaceId))
			.orderBy(desc(member.createdAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor
			.select({ value: count() })
			.from(member)
			.where(eq(member.organizationId, workspaceId))

		return { items, total: totals?.value ?? 0 }
	},

	async countMembers(workspaceId: string, executor: DbExecutor = db) {
		const [row] = await executor
			.select({ value: count() })
			.from(member)
			.where(eq(member.organizationId, workspaceId))
		return row?.value ?? 0
	},

	async countMembersWithRole(workspaceId: string, role: string, executor: DbExecutor = db) {
		const [row] = await executor
			.select({ value: count() })
			.from(member)
			.where(and(eq(member.organizationId, workspaceId), eq(member.role, role)))
		return row?.value ?? 0
	},

	/**
	 * Pending invitations count against the seat cap. Without this a workspace
	 * could invite past its plan limit and only discover the overage when every
	 * invitee accepted.
	 */
	async countPendingInvitations(workspaceId: string, executor: DbExecutor = db) {
		const [row] = await executor
			.select({ value: count() })
			.from(invitation)
			.where(
				and(eq(invitation.organizationId, workspaceId), eq(invitation.status, "pending")),
			)
		return row?.value ?? 0
	},

	async listInvitations(workspaceId: string, executor: DbExecutor = db) {
		return executor
			.select({
				id: invitation.id,
				email: invitation.email,
				role: invitation.role,
				status: invitation.status,
				expiresAt: invitation.expiresAt,
				createdAt: invitation.createdAt,
			})
			.from(invitation)
			.where(eq(invitation.organizationId, workspaceId))
			.orderBy(desc(invitation.createdAt))
	},

	async update(
		workspaceId: string,
		patch: Partial<Pick<WorkspaceRow, "name" | "logo" | "metadata">>,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.update(organization)
			.set(patch)
			.where(eq(organization.id, workspaceId))
			.returning()
		return rows[0]
	},
}
