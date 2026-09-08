import { and, asc, count, desc, eq, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { agent, agentRun, agentRunStep, agentVersion } from "../../db/schema"
import type { PaginationQuery } from "../../shared/pagination"

export type AgentRow = typeof agent.$inferSelect
export type AgentVersionRow = typeof agentVersion.$inferSelect
export type AgentRunRow = typeof agentRun.$inferSelect
export type AgentRunStepRow = typeof agentRunStep.$inferSelect

export const agentRepository = {
	/** `visible` narrows the page and the count together (ADR-054). */
	async list(
		workspaceId: string,
		query: PaginationQuery,
		visible: SQL | undefined,
		executor: DbExecutor = db,
	) {
		const where = visible
			? and(eq(agent.organizationId, workspaceId), visible)
			: eq(agent.organizationId, workspaceId)

		const items = await executor
			.select()
			.from(agent)
			.where(where)
			.orderBy(desc(agent.updatedAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor.select({ value: count() }).from(agent).where(where)

		return { items, total: totals?.value ?? 0 }
	},

	async findById(workspaceId: string, agentId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(agent)
			.where(and(eq(agent.organizationId, workspaceId), eq(agent.id, agentId)))
			.limit(1)
		return rows[0]
	},

	async insert(row: typeof agent.$inferInsert, executor: DbExecutor = db) {
		const [created] = await executor.insert(agent).values(row).returning()
		return created
	},

	async update(
		workspaceId: string,
		agentId: string,
		values: Partial<typeof agent.$inferInsert>,
		executor: DbExecutor = db,
	) {
		const [updated] = await executor
			.update(agent)
			.set(values)
			.where(and(eq(agent.organizationId, workspaceId), eq(agent.id, agentId)))
			.returning()
		return updated
	},

	async remove(workspaceId: string, agentId: string, executor: DbExecutor = db) {
		await executor
			.delete(agent)
			.where(and(eq(agent.organizationId, workspaceId), eq(agent.id, agentId)))
	},

	async insertVersion(row: typeof agentVersion.$inferInsert, executor: DbExecutor = db) {
		const [created] = await executor.insert(agentVersion).values(row).returning()
		return created
	},

	async listVersions(agentId: string, executor: DbExecutor = db) {
		return executor
			.select()
			.from(agentVersion)
			.where(eq(agentVersion.agentId, agentId))
			.orderBy(desc(agentVersion.version))
	},

	async findVersion(agentId: string, version: number, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(agentVersion)
			.where(and(eq(agentVersion.agentId, agentId), eq(agentVersion.version, version)))
			.limit(1)
		return rows[0]
	},

	/** By primary key, for a resumed run that must use the version it started on. */
	async findVersionById(versionId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(agentVersion)
			.where(eq(agentVersion.id, versionId))
			.limit(1)
		return rows[0]
	},

	/**
	 * The next version number, read inside the caller's transaction. The unique
	 * index on `(agent_id, version)` is what actually prevents two concurrent
	 * publishes from claiming the same number — this only picks the candidate.
	 */
	async nextVersion(agentId: string, executor: DbExecutor = db) {
		const [row] = await executor
			.select({ value: sql<number>`coalesce(max(${agentVersion.version}), 0) + 1` })
			.from(agentVersion)
			.where(eq(agentVersion.agentId, agentId))
		return row?.value ?? 1
	},

	async insertRun(row: typeof agentRun.$inferInsert, executor: DbExecutor = db) {
		const [created] = await executor.insert(agentRun).values(row).returning()
		return created
	},

	async updateRun(
		runId: string,
		values: Partial<typeof agentRun.$inferInsert>,
		executor: DbExecutor = db,
	) {
		const [updated] = await executor
			.update(agentRun)
			.set(values)
			.where(eq(agentRun.id, runId))
			.returning()
		return updated
	},

	async findRun(workspaceId: string, runId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(agentRun)
			.where(and(eq(agentRun.organizationId, workspaceId), eq(agentRun.id, runId)))
			.limit(1)
		return rows[0]
	},

	/** The runs of one comparison, oldest first so the versions read in order. */
	async listComparisonRuns(
		workspaceId: string,
		comparisonId: string,
		executor: DbExecutor = db,
	) {
		return executor
			.select()
			.from(agentRun)
			.where(
				and(
					eq(agentRun.organizationId, workspaceId),
					eq(agentRun.comparisonId, comparisonId),
				),
			)
			.orderBy(asc(agentRun.createdAt))
	},

	async listRuns(
		workspaceId: string,
		agentId: string,
		query: PaginationQuery,
		executor: DbExecutor = db,
	) {
		const where = and(eq(agentRun.organizationId, workspaceId), eq(agentRun.agentId, agentId))

		const items = await executor
			.select()
			.from(agentRun)
			.where(where)
			.orderBy(desc(agentRun.createdAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor.select({ value: count() }).from(agentRun).where(where)

		return { items, total: totals?.value ?? 0 }
	},

	/**
	 * A step is identified by `(run_id, seq)`, so a step this run has already
	 * written is the same step, not a second one.
	 *
	 * Conflicts are ignored rather than raised because an attempt picked up from
	 * a checkpoint replays the work that was in flight when the last one died,
	 * under the step numbers it already had — which is exactly what makes the
	 * matching `usage_ledger.reference` refuse to charge for it twice. Raising
	 * here would turn that safety into a crash on every resumed run.
	 */
	async insertStep(row: typeof agentRunStep.$inferInsert, executor: DbExecutor = db) {
		const [created] = await executor
			.insert(agentRunStep)
			.values(row)
			.onConflictDoNothing({ target: [agentRunStep.runId, agentRunStep.seq] })
			.returning()
		return created
	},

	/**
	 * Claims the run for an attempt. `attempts` counts how many times a run has
	 * been picked up — by a person, by the queue, or by a retry after a crash —
	 * which is otherwise invisible once the process that was executing it is gone.
	 */
	async startAttempt(runId: string, executor: DbExecutor = db) {
		const [updated] = await executor
			.update(agentRun)
			.set({ status: "running", attempts: sql`${agentRun.attempts} + 1` })
			.where(eq(agentRun.id, runId))
			.returning()
		return updated
	},

	async listSteps(runId: string, executor: DbExecutor = db) {
		return executor
			.select()
			.from(agentRunStep)
			.where(eq(agentRunStep.runId, runId))
			.orderBy(agentRunStep.seq)
	},
}
