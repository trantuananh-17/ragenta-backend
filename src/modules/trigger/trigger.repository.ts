import { and, asc, eq, lte, sql } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { agentTrigger } from "../../db/schema"

export type TriggerRow = typeof agentTrigger.$inferSelect

export const triggerRepository = {
	async listForAgent(
		workspaceId: string,
		agentId: string,
		executor: DbExecutor = db,
	): Promise<TriggerRow[]> {
		return executor
			.select()
			.from(agentTrigger)
			.where(
				and(
					eq(agentTrigger.organizationId, workspaceId),
					eq(agentTrigger.agentId, agentId),
				),
			)
			.orderBy(asc(agentTrigger.name))
	},

	/**
	 * By id alone, with no workspace filter — the one read that has none, because
	 * the webhook endpoint is called by a stranger who knows only the id. What
	 * stands in for the filter is the signature: the caller has to prove they hold
	 * the secret before anything happens with the row.
	 */
	async findById(triggerId: string, executor: DbExecutor = db): Promise<TriggerRow | undefined> {
		const rows = await executor
			.select()
			.from(agentTrigger)
			.where(eq(agentTrigger.id, triggerId))
			.limit(1)
		return rows[0]
	},

	async findScoped(
		workspaceId: string,
		triggerId: string,
		executor: DbExecutor = db,
	): Promise<TriggerRow | undefined> {
		const rows = await executor
			.select()
			.from(agentTrigger)
			.where(
				and(eq(agentTrigger.id, triggerId), eq(agentTrigger.organizationId, workspaceId)),
			)
			.limit(1)
		return rows[0]
	},

	async insert(row: typeof agentTrigger.$inferInsert, executor: DbExecutor = db): Promise<void> {
		await executor.insert(agentTrigger).values(row)
	},

	async update(
		triggerId: string,
		fields: Partial<typeof agentTrigger.$inferInsert>,
		executor: DbExecutor = db,
	): Promise<void> {
		await executor.update(agentTrigger).set(fields).where(eq(agentTrigger.id, triggerId))
	},

	async remove(triggerId: string, executor: DbExecutor = db): Promise<void> {
		await executor.delete(agentTrigger).where(eq(agentTrigger.id, triggerId))
	},

  /**
   * Schedules that are due, across every workspace.
   *
   * The scan is one indexed range query rather than a cron evaluation per row,
   * which is why `next_run_at` is materialised: the cost grows with the number
   * of triggers that are *due*, not with the number that exist.
   */
	async listDue(now: Date, limit: number, executor: DbExecutor = db): Promise<TriggerRow[]> {
		return executor
			.select()
			.from(agentTrigger)
			.where(
				and(
					eq(agentTrigger.kind, "schedule"),
					eq(agentTrigger.enabled, true),
					lte(agentTrigger.nextRunAt, now),
				),
			)
			.orderBy(asc(agentTrigger.nextRunAt))
			.limit(limit)
	},

	/**
	 * Claims a due trigger by moving its next run forward, and reports whether
	 * this caller is the one that got it.
	 *
	 * The `next_run_at` in the WHERE is the whole point: two workers scanning at
	 * the same second both see the row, and only the one whose update matches the
	 * value it read changes anything. Without it a schedule fires once per worker,
	 * which is a duplicate run and a duplicate bill.
	 */
	async claim(
		triggerId: string,
		expectedNextRunAt: Date,
		newNextRunAt: Date | null,
		executor: DbExecutor = db,
	): Promise<boolean> {
		const claimed = await executor
			.update(agentTrigger)
			.set({ nextRunAt: newNextRunAt, lastFiredAt: sql`now()` })
			.where(
				and(
					eq(agentTrigger.id, triggerId),
					eq(agentTrigger.nextRunAt, expectedNextRunAt),
				),
			)
			.returning({ id: agentTrigger.id })
		return claimed.length > 0
	},
}
