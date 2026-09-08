import { and, asc, eq, isNull, or } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { mcpServer } from "../../db/schema"
import type { McpToolSummary } from "../../db/schema/mcp.schema"

export type McpServerRow = typeof mcpServer.$inferSelect

/**
 * Resolution accepts a platform-wide row **or** this workspace's own, and never
 * another tenant's. The clause is in the statement rather than applied
 * afterwards, for the same reason `connection-scope.ts` puts it there: the name
 * being resolved came from a model (`.claude/rules/security.md`).
 */
export const mcpRepository = {
	async listForWorkspace(
		workspaceId: string,
		executor: DbExecutor = db,
	): Promise<McpServerRow[]> {
		return executor
			.select()
			.from(mcpServer)
			.where(
				or(isNull(mcpServer.organizationId), eq(mcpServer.organizationId, workspaceId)),
			)
			.orderBy(asc(mcpServer.slug))
	},

	/** Platform-wide rows only — the admin console's list. */
	async listPlatform(executor: DbExecutor = db): Promise<McpServerRow[]> {
		return executor
			.select()
			.from(mcpServer)
			.where(isNull(mcpServer.organizationId))
			.orderBy(asc(mcpServer.slug))
	},

	async findBySlugForWorkspace(
		workspaceId: string,
		slug: string,
		executor: DbExecutor = db,
	): Promise<McpServerRow | undefined> {
		const rows = await executor
			.select()
			.from(mcpServer)
			.where(
				and(
					eq(mcpServer.slug, slug),
					or(isNull(mcpServer.organizationId), eq(mcpServer.organizationId, workspaceId)),
				),
			)
			// A workspace's own row wins over a platform-wide one with the same slug.
			// `organization_id` sorts NULLs last under `desc` in Postgres, so the
			// owned row comes first — stated here because the ordering is the rule,
			// not a coincidence.
			.orderBy(asc(mcpServer.organizationId))
			.limit(1)
		return rows[0]
	},

	async findById(id: string, executor: DbExecutor = db): Promise<McpServerRow | undefined> {
		const rows = await executor.select().from(mcpServer).where(eq(mcpServer.id, id)).limit(1)
		return rows[0]
	},

	async upsert(row: typeof mcpServer.$inferInsert, executor: DbExecutor = db): Promise<void> {
		await executor
			.insert(mcpServer)
			.values(row)
			.onConflictDoUpdate({ target: mcpServer.id, set: row })
	},

	async update(
		id: string,
		fields: Partial<typeof mcpServer.$inferInsert>,
		executor: DbExecutor = db,
	): Promise<void> {
		await executor.update(mcpServer).set(fields).where(eq(mcpServer.id, id))
	},

	async remove(id: string, executor: DbExecutor = db): Promise<void> {
		await executor.delete(mcpServer).where(eq(mcpServer.id, id))
	},

	async cacheTools(
		id: string,
		tools: McpToolSummary[],
		executor: DbExecutor = db,
	): Promise<void> {
		await executor
			.update(mcpServer)
			.set({ toolsCache: tools, toolsCachedAt: new Date() })
			.where(eq(mcpServer.id, id))
	},
}
