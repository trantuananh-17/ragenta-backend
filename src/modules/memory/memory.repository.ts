import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { agentMemory } from "../../db/schema"

export type MemoryRow = typeof agentMemory.$inferSelect

/**
 * Every read carries the workspace id as well as the agent id. Redundant while
 * an agent belongs to one workspace, and still correct if that stops being true
 * — a recall crossing tenants would put one customer's private notes into
 * another's prompt.
 */
export const memoryRepository = {
	async insert(row: typeof agentMemory.$inferInsert, executor: DbExecutor = db): Promise<void> {
		await executor.insert(agentMemory).values(row)
	},

	async findByIds(
		workspaceId: string,
		agentId: string,
		ids: string[],
		executor: DbExecutor = db,
	): Promise<MemoryRow[]> {
		if (ids.length === 0) return []
		return executor
			.select()
			.from(agentMemory)
			.where(
				and(
					eq(agentMemory.organizationId, workspaceId),
					eq(agentMemory.agentId, agentId),
					inArray(agentMemory.id, ids),
				),
			)
	},

	/**
	 * What this agent already remembers that is close enough to be a duplicate.
	 *
	 * Exact-match rather than similarity: a model asked to remember the same fact
	 * twice usually writes it identically, and catching that costs one indexed
	 * lookup. Near-duplicates are a real problem and the wrong one to solve with a
	 * guess — an embedding comparison that merges two subtly different facts is
	 * worse than two rows.
	 */
	async findIdentical(
		agentId: string,
		userId: string | null,
		content: string,
		executor: DbExecutor = db,
	): Promise<MemoryRow | undefined> {
		const rows = await executor
			.select()
			.from(agentMemory)
			.where(
				and(
					eq(agentMemory.agentId, agentId),
					userId === null ? isNull(agentMemory.userId) : eq(agentMemory.userId, userId),
					eq(agentMemory.content, content),
				),
			)
			.limit(1)
		return rows[0]
	},

	/** Everything one agent remembers, for the screen and for a recall fallback. */
	async list(
		workspaceId: string,
		agentId: string,
		userId: string | null,
		limit: number,
		executor: DbExecutor = db,
	): Promise<MemoryRow[]> {
		return executor
			.select()
			.from(agentMemory)
			.where(
				and(
					eq(agentMemory.organizationId, workspaceId),
					eq(agentMemory.agentId, agentId),
					// A user-scoped read sees the shared memories plus their own, never
					// somebody else's. The clause is here rather than at the caller for
					// the same reason every other tenant filter is.
					userId === null
						? isNull(agentMemory.userId)
						: or(isNull(agentMemory.userId), eq(agentMemory.userId, userId)),
				),
			)
			.orderBy(desc(agentMemory.createdAt))
			.limit(limit)
	},

	async touch(ids: string[], executor: DbExecutor = db): Promise<void> {
		if (ids.length === 0) return
		await executor
			.update(agentMemory)
			.set({ lastUsedAt: sql`now()` })
			.where(inArray(agentMemory.id, ids))
	},

	async remove(
		workspaceId: string,
		agentId: string,
		memoryId: string,
		executor: DbExecutor = db,
	): Promise<MemoryRow | undefined> {
		const rows = await executor
			.delete(agentMemory)
			.where(
				and(
					eq(agentMemory.organizationId, workspaceId),
					eq(agentMemory.agentId, agentId),
					eq(agentMemory.id, memoryId),
				),
			)
			.returning()
		return rows[0]
	},

	async removeAll(
		workspaceId: string,
		agentId: string,
		userId: string | null,
		executor: DbExecutor = db,
	): Promise<MemoryRow[]> {
		return executor
			.delete(agentMemory)
			.where(
				and(
					eq(agentMemory.organizationId, workspaceId),
					eq(agentMemory.agentId, agentId),
					...(userId === null ? [] : [eq(agentMemory.userId, userId)]),
				),
			)
			.returning()
	},

	/**
	 * How many memories this agent holds in one scope, for the per-agent cap.
	 *
	 * The cap exists because nothing else bounds this: a chatty agent writing one
	 * memory a turn produces an index nobody asked for and a recall that gets
	 * worse the longer it runs.
	 */
	async count(agentId: string, userId: string | null, executor: DbExecutor = db): Promise<number> {
		const rows = await executor
			.select({ id: agentMemory.id })
			.from(agentMemory)
			.where(
				and(
					eq(agentMemory.agentId, agentId),
					userId === null ? isNull(agentMemory.userId) : eq(agentMemory.userId, userId),
				),
			)
		return rows.length
	},

	/** The least recently used memories in a scope — what a cap evicts first. */
	async oldestUnused(
		agentId: string,
		userId: string | null,
		howMany: number,
		executor: DbExecutor = db,
	): Promise<MemoryRow[]> {
		if (howMany <= 0) return []
		return executor
			.select()
			.from(agentMemory)
			.where(
				and(
					eq(agentMemory.agentId, agentId),
					userId === null ? isNull(agentMemory.userId) : eq(agentMemory.userId, userId),
				),
			)
			.orderBy(agentMemory.lastUsedAt)
			.limit(howMany)
	},
}
