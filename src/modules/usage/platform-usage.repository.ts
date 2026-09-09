import { and, gte, lt, sql } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { organization, usageLedger } from "../../db/schema"

/**
 * Platform-wide aggregates over `usage_ledger` — what every model and every
 * workspace has actually consumed.
 *
 * **The arithmetic runs in Postgres, not in Node.** This is the fastest-growing
 * table in the database, and pulling a month of rows across every tenant into
 * memory to sum them is the version of this that works until the day it does
 * not — and that day arrives without warning, on the request that runs out of
 * heap.
 *
 * Deliberately not workspace-scoped, which every other repository here is. That
 * is the point of the screen it serves, and it is why the routes behind it carry
 * `admin.usage.read` and appear nowhere else (ADR-051).
 */

/** Half-open, `[from, to)`, so a day is never counted twice at a boundary. */
function within(from: Date, to: Date) {
	return and(gte(usageLedger.createdAt, from), lt(usageLedger.createdAt, to))
}

/**
 * Credits are `numeric` and come back as a string, which is right — the value is
 * exact in Postgres and a float is not. The API returns it as a string for the
 * same reason; formatting it is the client's job.
 */
const creditSum = sql<string>`coalesce(sum(${usageLedger.credits}), 0)::text`
/**
 * What the providers charged us over the same rows — cost of goods, beside the
 * credits that are revenue. Summed from the frozen per-row figure rather than
 * converted from credits here, so a change to the credit baseline cannot restate
 * a month that has already been reported.
 */
const costSum = sql<string>`coalesce(sum(${usageLedger.costUsd}), 0)::text`
const calls = sql<number>`count(*)::int`
const inputTokens = sql<number>`coalesce(sum(${usageLedger.inputTokens}), 0)::bigint::text`
const outputTokens = sql<number>`coalesce(sum(${usageLedger.outputTokens}), 0)::bigint::text`
const embeddingTokens = sql<number>`coalesce(sum(${usageLedger.embeddingTokens}), 0)::bigint::text`

export const platformUsageRepository = {
	async byModel(from: Date, to: Date, executor: DbExecutor = db) {
		return executor
			.select({
				provider: usageLedger.provider,
				model: usageLedger.model,
				calls,
				inputTokens,
				outputTokens,
				embeddingTokens,
				credits: creditSum,
				costUsd: costSum,
				workspaces: sql<number>`count(distinct ${usageLedger.organizationId})::int`,
			})
			.from(usageLedger)
			.where(within(from, to))
			.groupBy(usageLedger.provider, usageLedger.model)
			.orderBy(sql`sum(${usageLedger.credits}) desc`)
	},

	async byOperation(from: Date, to: Date, executor: DbExecutor = db) {
		return executor
			.select({
				operation: usageLedger.operation,
				calls,
				inputTokens,
				outputTokens,
				embeddingTokens,
				credits: creditSum,
				costUsd: costSum,
			})
			.from(usageLedger)
			.where(within(from, to))
			.groupBy(usageLedger.operation)
			.orderBy(sql`sum(${usageLedger.credits}) desc`)
	},

	async byWorkspace(from: Date, to: Date, limit: number, executor: DbExecutor = db) {
		return executor
			.select({
				workspaceId: usageLedger.organizationId,
				// A workspace deleted since the row was written leaves the ledger
				// behind on purpose — the spend happened. Name it rather than drop it.
				name: sql<string>`coalesce(${organization.name}, '(deleted workspace)')`,
				calls,
				inputTokens,
				outputTokens,
				embeddingTokens,
				credits: creditSum,
				costUsd: costSum,
			})
			.from(usageLedger)
			.leftJoin(organization, sql`${organization.id} = ${usageLedger.organizationId}`)
			.where(within(from, to))
			.groupBy(usageLedger.organizationId, organization.name)
			.orderBy(sql`sum(${usageLedger.credits}) desc`)
			.limit(limit)
	},

	async daily(from: Date, to: Date, executor: DbExecutor = db) {
		return executor
			.select({
				day: sql<string>`to_char(date_trunc('day', ${usageLedger.createdAt}), 'YYYY-MM-DD')`,
				calls,
				inputTokens,
				outputTokens,
				embeddingTokens,
				credits: creditSum,
				costUsd: costSum,
			})
			.from(usageLedger)
			.where(within(from, to))
			.groupBy(sql`date_trunc('day', ${usageLedger.createdAt})`)
			.orderBy(sql`date_trunc('day', ${usageLedger.createdAt})`)
	},

	/**
	 * How long provider calls are taking, as percentiles.
	 *
	 * `percentile_cont` in Postgres rather than sorting the durations in Node, for
	 * the reason every other aggregate here runs in SQL — and rows with no
	 * duration are excluded rather than counted as zero, which would drag every
	 * percentile toward a number nothing actually took (ADR-063).
	 */
	async latency(from: Date, to: Date, executor: DbExecutor = db) {
		return executor
			.select({
				operation: usageLedger.operation,
				calls: sql<number>`count(*)::int`,
				p50: sql<number>`percentile_cont(0.5) within group (order by ${usageLedger.durationMs})::int`,
				p95: sql<number>`percentile_cont(0.95) within group (order by ${usageLedger.durationMs})::int`,
				p99: sql<number>`percentile_cont(0.99) within group (order by ${usageLedger.durationMs})::int`,
				slowest: sql<number>`max(${usageLedger.durationMs})::int`,
			})
			.from(usageLedger)
			.where(and(within(from, to), sql`${usageLedger.durationMs} is not null`))
			.groupBy(usageLedger.operation)
			.orderBy(sql`count(*) desc`)
	},

	async totals(from: Date, to: Date, executor: DbExecutor = db) {
		const rows = await executor
			.select({
				calls,
				inputTokens,
				outputTokens,
				embeddingTokens,
				credits: creditSum,
				costUsd: costSum,
				workspaces: sql<number>`count(distinct ${usageLedger.organizationId})::int`,
				models: sql<number>`count(distinct (${usageLedger.provider} || '/' || ${usageLedger.model}))::int`,
			})
			.from(usageLedger)
			.where(within(from, to))
		return rows[0]
	},
}
