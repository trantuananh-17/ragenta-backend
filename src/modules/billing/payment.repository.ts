import { and, desc, eq, gte, lt, sql } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { organization, payment } from "../../db/schema"
import type { PaginationQuery } from "../../shared/pagination"

export type PaymentRow = typeof payment.$inferSelect
export type NewPayment = typeof payment.$inferInsert

/**
 * What has been collected, per workspace and across the platform.
 *
 * Separate from `billing.repository` because it answers a different question:
 * that one owns the credit balance and its ledger — what a workspace may spend —
 * and this one owns the money that bought it.
 */
export const paymentRepository = {
	/**
	 * Insert-or-update on the provider's id.
	 *
	 * A webhook redelivery is a no-op, and a charge that failed and then succeeded
	 * moves one row from `failed` to `paid` rather than writing a second: it is one
	 * attempt to collect one amount, and two lines for it would read as two bills.
	 */
	async record(values: NewPayment, executor: DbExecutor = db): Promise<PaymentRow | undefined> {
		const { id: _id, createdAt: _createdAt, ...updatable } = values
		const rows = await executor
			.insert(payment)
			.values(values)
			.onConflictDoUpdate({
				target: payment.externalId,
				set: { ...updatable, updatedAt: new Date() },
			})
			.returning()
		return rows[0]
	},

	async listForWorkspace(workspaceId: string, query: PaginationQuery, executor: DbExecutor = db) {
		const where = eq(payment.organizationId, workspaceId)

		const items = await executor
			.select()
			.from(payment)
			.where(where)
			.orderBy(desc(payment.createdAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor
			.select({ value: sql<number>`count(*)::int` })
			.from(payment)
			.where(where)

		return { items, total: totals?.value ?? 0 }
	},

	/** Cross-tenant, for the console. Names the workspace so the row is readable. */
	async listAll(
		filters: { workspaceId?: string; status?: string },
		query: PaginationQuery,
		executor: DbExecutor = db,
	) {
		const clauses = [
			filters.workspaceId ? eq(payment.organizationId, filters.workspaceId) : undefined,
			filters.status ? eq(payment.status, filters.status) : undefined,
		].filter(Boolean)
		const where = clauses.length > 0 ? and(...clauses) : undefined

		const items = await executor
			.select({
				id: payment.id,
				organizationId: payment.organizationId,
				workspaceName: sql<string>`coalesce(${organization.name}, '(deleted workspace)')`,
				kind: payment.kind,
				status: payment.status,
				amountUsd: payment.amountUsd,
				currency: payment.currency,
				description: payment.description,
				hostedInvoiceUrl: payment.hostedInvoiceUrl,
				periodStart: payment.periodStart,
				periodEnd: payment.periodEnd,
				createdAt: payment.createdAt,
			})
			.from(payment)
			.leftJoin(organization, eq(organization.id, payment.organizationId))
			.where(where)
			.orderBy(desc(payment.createdAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor
			.select({ value: sql<number>`count(*)::int` })
			.from(payment)
			.where(where)

		return { items, total: totals?.value ?? 0 }
	},

	/**
	 * What was actually collected in a range.
	 *
	 * Only `paid`. A failed charge is a row worth keeping — it is why a customer
	 * lost access — but counting it as revenue would report money nobody sent.
	 */
	async collectedWithin(from: Date, to: Date, executor: DbExecutor = db) {
		const rows = await executor
			.select({
				kind: payment.kind,
				usd: sql<string>`coalesce(sum(${payment.amountUsd}), 0)::text`,
				payments: sql<number>`count(*)::int`,
			})
			.from(payment)
			.where(
				and(
					eq(payment.status, "paid"),
					gte(payment.createdAt, from),
					lt(payment.createdAt, to),
				),
			)
			.groupBy(payment.kind)

		return rows
	},
}
