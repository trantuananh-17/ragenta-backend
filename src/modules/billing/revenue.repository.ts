import { and, count, eq, gte, inArray, lt, sql } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { creditTransaction, member, organization, subscription, usageLedger } from "../../db/schema"
import { ACTIVE_SUBSCRIPTION_STATUSES } from "./plans"

/**
 * The two halves of the margin, read straight from the tables that own them.
 *
 * Revenue and cost live in different places on purpose: what a workspace pays is
 * a subscription and a set of purchases, what it costs us is a pile of provider
 * calls, and nothing in the product writes a row that already contains both.
 * This repository reads each half and leaves the subtraction to the service.
 *
 * Cross-tenant, like `platform-usage.repository`, and behind the same permission
 * for the same reason (ADR-051).
 */

/** Half-open, `[from, to)`, matching every other spend report. */
function within(from: Date, to: Date) {
	return and(gte(creditTransaction.createdAt, from), lt(creditTransaction.createdAt, to))
}

export const revenueRepository = {
	/**
	 * Every workspace whose subscription entitles it to its plan, with the seats
	 * it actually occupies.
	 *
	 * Seats are counted from `member` rather than read from `subscription.seats`:
	 * that column is written by the payment provider's webhook and is null for
	 * every workspace that never went through checkout, which on this deployment
	 * is most of them.
	 */
	async activeSubscriptions(executor: DbExecutor = db) {
		return executor
			.select({
				workspaceId: subscription.organizationId,
				name: sql<string>`coalesce(${organization.name}, '(deleted workspace)')`,
				plan: subscription.plan,
				status: subscription.status,
				seats: sql<number>`count(${member.id})::int`,
			})
			.from(subscription)
			.leftJoin(organization, eq(organization.id, subscription.organizationId))
			.leftJoin(member, eq(member.organizationId, subscription.organizationId))
			.where(inArray(subscription.status, [...ACTIVE_SUBSCRIPTION_STATUSES]))
			.groupBy(
				subscription.organizationId,
				organization.name,
				subscription.plan,
				subscription.status,
			)
	},

	/**
	 * Top-ups bought in the range, grouped by the credits each granted.
	 *
	 * Grouped by amount rather than summed, because the ledger records credits and
	 * the money is only recoverable by matching an amount to a pack's list price.
	 * A row whose amount matches no pack is returned all the same so the service
	 * can report it as unpriced instead of quietly valuing it at zero.
	 */
	async topupsWithin(from: Date, to: Date, executor: DbExecutor = db) {
		return executor
			.select({
				credits: creditTransaction.amount,
				purchases: count(),
			})
			.from(creditTransaction)
			.where(and(eq(creditTransaction.kind, "topup"), within(from, to)))
			.groupBy(creditTransaction.amount)
	},

	/** What the providers charged us in the range, from the frozen per-row figure. */
	async costWithin(from: Date, to: Date, executor: DbExecutor = db) {
		const rows = await executor
			.select({
				usd: sql<string>`coalesce(sum(${usageLedger.costUsd}), 0)::text`,
				credits: sql<string>`coalesce(sum(${usageLedger.credits}), 0)::text`,
				calls: sql<number>`count(*)::int`,
			})
			.from(usageLedger)
			.where(and(gte(usageLedger.createdAt, from), lt(usageLedger.createdAt, to)))
		return rows[0]
	},

	/** Cost per workspace in the range — who the money is actually going on. */
	async costByWorkspace(from: Date, to: Date, limit: number, executor: DbExecutor = db) {
		return executor
			.select({
				workspaceId: usageLedger.organizationId,
				name: sql<string>`coalesce(${organization.name}, '(deleted workspace)')`,
				usd: sql<string>`coalesce(sum(${usageLedger.costUsd}), 0)::text`,
				credits: sql<string>`coalesce(sum(${usageLedger.credits}), 0)::text`,
				calls: sql<number>`count(*)::int`,
			})
			.from(usageLedger)
			.leftJoin(organization, eq(organization.id, usageLedger.organizationId))
			.where(and(gte(usageLedger.createdAt, from), lt(usageLedger.createdAt, to)))
			.groupBy(usageLedger.organizationId, organization.name)
			.orderBy(sql`sum(${usageLedger.costUsd}) desc`)
			.limit(limit)
	},

	/** Daily cost, so the report can show where a month went. */
	async dailyCost(from: Date, to: Date, executor: DbExecutor = db) {
		return executor
			.select({
				day: sql<string>`to_char(date_trunc('day', ${usageLedger.createdAt}), 'YYYY-MM-DD')`,
				usd: sql<string>`coalesce(sum(${usageLedger.costUsd}), 0)::text`,
			})
			.from(usageLedger)
			.where(and(gte(usageLedger.createdAt, from), lt(usageLedger.createdAt, to)))
			.groupBy(sql`date_trunc('day', ${usageLedger.createdAt})`)
			.orderBy(sql`date_trunc('day', ${usageLedger.createdAt})`)
	},
}
