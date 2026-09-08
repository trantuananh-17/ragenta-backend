import { and, asc, eq, gte, sql } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { agentRun, chatWidget, usageLedger } from "../../db/schema"

export type ChatWidgetRow = typeof chatWidget.$inferSelect

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
