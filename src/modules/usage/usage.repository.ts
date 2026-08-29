import { and, count, desc, eq, gte, sum } from "drizzle-orm"
import type { SQL } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { usageLedger } from "../../db/schema"
import type { PaginationQuery } from "../../shared/pagination"

export type UsageLedgerRow = typeof usageLedger.$inferSelect
export type NewUsageLedger = typeof usageLedger.$inferInsert

export interface UsageFilter {
	projectId?: string
	operation?: string
}

export const usageRepository = {
	/**
	 * `onConflictDoNothing` on the unique reference: a retried charge re-enters
	 * this with the same reference, and the credit side has already decided it is
	 * a no-op. Both sides must agree.
	 */
	async insert(entry: NewUsageLedger, executor: DbExecutor) {
		const rows = await executor
			.insert(usageLedger)
			.values(entry)
			.onConflictDoNothing({ target: usageLedger.reference })
			.returning()
		return rows[0]
	},

	async list(
		workspaceId: string,
		filter: UsageFilter,
		query: PaginationQuery,
		executor: DbExecutor = db,
	) {
		const conditions: SQL[] = [eq(usageLedger.organizationId, workspaceId)]
		if (filter.projectId) conditions.push(eq(usageLedger.projectId, filter.projectId))
		if (filter.operation) conditions.push(eq(usageLedger.operation, filter.operation))
		const where = and(...conditions)

		const items = await executor
			.select()
			.from(usageLedger)
			.where(where)
			.orderBy(desc(usageLedger.createdAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor.select({ value: count() }).from(usageLedger).where(where)
		return { items, total: totals?.value ?? 0 }
	},

	/** Spend grouped by operation and model over a window — what the usage screens read. */
	async summarize(workspaceId: string, since: Date, executor: DbExecutor = db) {
		return executor
			.select({
				operation: usageLedger.operation,
				provider: usageLedger.provider,
				model: usageLedger.model,
				calls: count(),
				inputTokens: sum(usageLedger.inputTokens),
				outputTokens: sum(usageLedger.outputTokens),
				embeddingTokens: sum(usageLedger.embeddingTokens),
				credits: sum(usageLedger.credits),
			})
			.from(usageLedger)
			.where(
				and(
					eq(usageLedger.organizationId, workspaceId),
					gte(usageLedger.createdAt, since),
				),
			)
			.groupBy(usageLedger.operation, usageLedger.provider, usageLedger.model)
	},
}
