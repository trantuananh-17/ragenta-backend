import { count, desc, eq, ilike, or } from "drizzle-orm"
import type { SQL } from "drizzle-orm"

import { db } from "../../db/client"
import { creditBalance, member, organization, subscription, user } from "../../db/schema"
import type { PaginationQuery } from "../../shared/pagination"

/**
 * Cross-tenant reads for platform administration. This is the only repository
 * that is not workspace-scoped, which is exactly why every route that reaches it
 * sits behind `requireAdmin`.
 */
export const adminRepository = {
	async listUsers(search: string | undefined, query: PaginationQuery) {
		const where: SQL | undefined = search
			? or(ilike(user.email, `%${search}%`), ilike(user.name, `%${search}%`))
			: undefined

		const items = await db
			.select({
				id: user.id,
				name: user.name,
				email: user.email,
				emailVerified: user.emailVerified,
				role: user.role,
				banned: user.banned,
				createdAt: user.createdAt,
			})
			.from(user)
			.where(where)
			.orderBy(desc(user.createdAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await db.select({ value: count() }).from(user).where(where)
		return { items, total: totals?.value ?? 0 }
	},

	async listWorkspaces(search: string | undefined, query: PaginationQuery) {
		const where: SQL | undefined = search
			? or(ilike(organization.name, `%${search}%`), ilike(organization.slug, `%${search}%`))
			: undefined

		const items = await db
			.select({
				id: organization.id,
				name: organization.name,
				slug: organization.slug,
				createdAt: organization.createdAt,
				plan: subscription.plan,
				subscriptionStatus: subscription.status,
				planCredits: creditBalance.planCredits,
				topupCredits: creditBalance.topupCredits,
			})
			.from(organization)
			.leftJoin(subscription, eq(subscription.organizationId, organization.id))
			.leftJoin(creditBalance, eq(creditBalance.organizationId, organization.id))
			.where(where)
			.orderBy(desc(organization.createdAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await db.select({ value: count() }).from(organization).where(where)
		return { items, total: totals?.value ?? 0 }
	},

	async countWorkspaceMembers(workspaceId: string) {
		const [row] = await db
			.select({ value: count() })
			.from(member)
			.where(eq(member.organizationId, workspaceId))
		return row?.value ?? 0
	},
}
