import { and, asc, eq, isNull, sql } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { apiKey } from "../../db/schema"

export type ApiKeyRow = typeof apiKey.$inferSelect

export const apiKeyRepository = {
	async list(workspaceId: string, executor: DbExecutor = db): Promise<ApiKeyRow[]> {
		return executor
			.select()
			.from(apiKey)
			.where(eq(apiKey.organizationId, workspaceId))
			.orderBy(asc(apiKey.createdAt))
	},

	/**
	 * By hash alone, with no workspace filter — the one read here that has none,
	 * because a caller presenting a key knows nothing else. The hash *is* the
	 * scope: it resolves to exactly one row, and that row names the workspace.
	 */
	async findByHash(keyHash: string, executor: DbExecutor = db): Promise<ApiKeyRow | undefined> {
		const rows = await executor
			.select()
			.from(apiKey)
			.where(and(eq(apiKey.keyHash, keyHash), isNull(apiKey.revokedAt)))
			.limit(1)
		return rows[0]
	},

	async findScoped(
		workspaceId: string,
		keyId: string,
		executor: DbExecutor = db,
	): Promise<ApiKeyRow | undefined> {
		const rows = await executor
			.select()
			.from(apiKey)
			.where(and(eq(apiKey.organizationId, workspaceId), eq(apiKey.id, keyId)))
			.limit(1)
		return rows[0]
	},

	async insert(row: typeof apiKey.$inferInsert, executor: DbExecutor = db): Promise<void> {
		await executor.insert(apiKey).values(row)
	},

	/**
	 * Revoked, not deleted.
	 *
	 * A deleted key leaves no record that it ever existed, which is the wrong
	 * answer to "what was this key doing last Tuesday". The row stays, the hash
	 * stops matching, and the audit trail still has something to point at.
	 */
	async revoke(keyId: string, executor: DbExecutor = db): Promise<void> {
		await executor.update(apiKey).set({ revokedAt: new Date() }).where(eq(apiKey.id, keyId))
	},

	async touch(keyId: string, executor: DbExecutor = db): Promise<void> {
		await executor.update(apiKey).set({ lastUsedAt: sql`now()` }).where(eq(apiKey.id, keyId))
	},
}
