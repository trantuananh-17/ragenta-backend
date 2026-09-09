import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { agentRun, chatWidget, usageLedger } from "../../db/schema"

export type ChatWidgetRow = typeof chatWidget.$inferSelect

/** Half-open, `[from, to)`, so a day is never counted at both ends. */
function inRange(widgetId: string, from: Date, to: Date) {
	return and(
		eq(agentRun.widgetId, widgetId),
		gte(agentRun.createdAt, from),
		lt(agentRun.createdAt, to),
	)
}

export const widgetRepository = {
	async list(workspaceId: string, executor: DbExecutor = db): Promise<ChatWidgetRow[]> {
		return executor
			.select()
			.from(chatWidget)
			.where(eq(chatWidget.organizationId, workspaceId))
			.orderBy(asc(chatWidget.name))
	},

	async count(workspaceId: string, executor: DbExecutor = db): Promise<number> {
		const rows = await executor
			.select({ id: chatWidget.id })
			.from(chatWidget)
			.where(eq(chatWidget.organizationId, workspaceId))
		return rows.length
	},

	/**
	 * By key alone, with no workspace filter — the one read here that has none,
	 * because a visitor on somebody's shop knows only the key. The key resolves to
	 * exactly one row, and that row names the workspace.
	 */
	async findByKey(publicKey: string, executor: DbExecutor = db): Promise<ChatWidgetRow | undefined> {
		const rows = await executor
			.select()
			.from(chatWidget)
			.where(eq(chatWidget.publicKey, publicKey))
			.limit(1)
		return rows[0]
	},

	async findScoped(
		workspaceId: string,
		widgetId: string,
		executor: DbExecutor = db,
	): Promise<ChatWidgetRow | undefined> {
		const rows = await executor
			.select()
			.from(chatWidget)
			.where(and(eq(chatWidget.organizationId, workspaceId), eq(chatWidget.id, widgetId)))
			.limit(1)
		return rows[0]
	},

	async upsert(row: typeof chatWidget.$inferInsert, executor: DbExecutor = db): Promise<void> {
		await executor
			.insert(chatWidget)
			.values(row)
			.onConflictDoUpdate({ target: chatWidget.id, set: row })
	},

	async remove(widgetId: string, executor: DbExecutor = db): Promise<void> {
		await executor.delete(chatWidget).where(eq(chatWidget.id, widgetId))
	},

	/**
	 * What one widget has answered over a range.
	 *
	 * Aggregated from `agent_run` rather than from the ledger: a widget turn is one
	 * run, the run already carries the credits it was charged, and counting runs is
	 * the only honest way to say "messages" — the ledger holds a row per provider
	 * call, which is several per answer once retrieval and the model are both
	 * charged.
	 *
	 * Duration comes from the run's own timestamps and is null while it is still
	 * going, which `avg` skips rather than counting as zero.
	 */
	async usageTotals(widgetId: string, from: Date, to: Date, executor: DbExecutor = db) {
		const rows = await executor
			.select({
				messages: sql<number>`count(*)::int`,
				succeeded: sql<number>`count(*) filter (where ${agentRun.status} = 'succeeded')::int`,
				failed: sql<number>`count(*) filter (where ${agentRun.status} = 'failed')::int`,
				credits: sql<string>`coalesce(sum(${agentRun.credits}), 0)::text`,
				avgDurationMs: sql<
					number | null
				>`avg(extract(epoch from (${agentRun.finishedAt} - ${agentRun.startedAt})) * 1000)::int`,
			})
			.from(agentRun)
			.where(inRange(widgetId, from, to))

		return rows[0]
	},

	async dailyUsage(widgetId: string, from: Date, to: Date, executor: DbExecutor = db) {
		return executor
			.select({
				day: sql<string>`to_char(date_trunc('day', ${agentRun.createdAt}), 'YYYY-MM-DD')`,
				messages: sql<number>`count(*)::int`,
				credits: sql<string>`coalesce(sum(${agentRun.credits}), 0)::text`,
			})
			.from(agentRun)
			.where(inRange(widgetId, from, to))
			.groupBy(sql`date_trunc('day', ${agentRun.createdAt})`)
			.orderBy(sql`date_trunc('day', ${agentRun.createdAt})`)
	},

	/**
	 * The last conversations, for the log.
	 *
	 * Both sides are truncated in SQL. A visitor can paste a page into a chat box
	 * and an answer can be long; a screen that lists thirty of them should not
	 * carry the whole of any of them across the wire to render two lines.
	 */
	async recentRuns(widgetId: string, from: Date, to: Date, limit: number, executor: DbExecutor = db) {
		return executor
			.select({
				id: agentRun.id,
				status: agentRun.status,
				createdAt: agentRun.createdAt,
				credits: agentRun.credits,
				error: agentRun.error,
				question: sql<string | null>`left(${agentRun.input} ->> 'input', 280)`,
				answer: sql<string | null>`left(${agentRun.output}, 280)`,
				durationMs: sql<
					number | null
				>`(extract(epoch from (${agentRun.finishedAt} - ${agentRun.startedAt})) * 1000)::int`,
			})
			.from(agentRun)
			.where(inRange(widgetId, from, to))
			.orderBy(desc(agentRun.createdAt))
			.limit(limit)
	},

	/**
	 * What this widget has spent today, in UTC.
	 *
	 * Summed from `usage_ledger` rather than kept as a counter: the ledger is
	 * already the truth about spending, and a second counter is a second thing
	 * that can drift from it. Joined through `agent_run.widget_id`, so a widget
	 * turn is charged exactly as every other agent run is and the reference format
	 * stays one thing.
	 */
	async spentToday(widgetId: string, executor: DbExecutor = db): Promise<number> {
		const since = new Date()
		since.setUTCHours(0, 0, 0, 0)

		const rows = await executor
			.select({ total: sql<string>`coalesce(sum(${usageLedger.credits}), 0)::text` })
			.from(usageLedger)
			.innerJoin(
				agentRun,
				sql`${usageLedger.reference} like 'agent-run:' || ${agentRun.id} || ':%'`,
			)
			.where(and(gte(usageLedger.createdAt, since), eq(agentRun.widgetId, widgetId)))

		return Number(rows[0]?.total ?? 0)
	},
}
