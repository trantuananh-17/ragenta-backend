import { and, asc, eq } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { oauthConnection } from "../../db/schema"

export type OAuthConnectionRow = typeof oauthConnection.$inferSelect

/**
 * Every read carries the workspace id. A connection is somebody's own account in
 * another system, so a query that could return another tenant's row is the worst
 * mistake available here.
 */
export const oauthRepository = {
	async list(workspaceId: string, executor: DbExecutor = db): Promise<OAuthConnectionRow[]> {
		return executor
			.select()
			.from(oauthConnection)
			.where(eq(oauthConnection.organizationId, workspaceId))
			.orderBy(asc(oauthConnection.provider), asc(oauthConnection.accountLabel))
	},

	async findById(
		workspaceId: string,
		connectionId: string,
		executor: DbExecutor = db,
	): Promise<OAuthConnectionRow | undefined> {
		const rows = await executor
			.select()
			.from(oauthConnection)
			.where(
				and(
					eq(oauthConnection.organizationId, workspaceId),
					eq(oauthConnection.id, connectionId),
				),
			)
			.limit(1)
		return rows[0]
	},

	/**
	 * The connection a tool should act through, when it was given a provider and
	 * not a specific account.
	 *
	 * The oldest active one, deliberately: it is the one somebody connected first
	 * and the one they will think of. Picking the newest would mean a fresh
	 * reconnect silently changing which account an agent posts as.
	 */
	async findActive(
		workspaceId: string,
		provider: string,
		executor: DbExecutor = db,
	): Promise<OAuthConnectionRow | undefined> {
		const rows = await executor
			.select()
			.from(oauthConnection)
			.where(
				and(
					eq(oauthConnection.organizationId, workspaceId),
					eq(oauthConnection.provider, provider),
					eq(oauthConnection.status, "active"),
				),
			)
			.orderBy(asc(oauthConnection.createdAt))
			.limit(1)
		return rows[0]
	},

	async upsert(
		row: typeof oauthConnection.$inferInsert,
		executor: DbExecutor = db,
	): Promise<void> {
		await executor
			.insert(oauthConnection)
			.values(row)
			.onConflictDoUpdate({
				target: [
					oauthConnection.organizationId,
					oauthConnection.provider,
					oauthConnection.externalAccountId,
				],
				// Reconnecting the same account replaces its tokens rather than
				// leaving a stale row a tool might pick and fail on. The id and who
				// first granted it are kept: it is the same connection.
				set: {
					accountLabel: row.accountLabel,
					scopes: row.scopes,
					encryptedAccessToken: row.encryptedAccessToken,
					encryptedRefreshToken: row.encryptedRefreshToken,
					expiresAt: row.expiresAt,
					status: "active",
					lastError: null,
				},
			})
	},

	async update(
		connectionId: string,
		fields: Partial<typeof oauthConnection.$inferInsert>,
		executor: DbExecutor = db,
	): Promise<void> {
		await executor
			.update(oauthConnection)
			.set(fields)
			.where(eq(oauthConnection.id, connectionId))
	},

	async remove(
		workspaceId: string,
		connectionId: string,
		executor: DbExecutor = db,
	): Promise<OAuthConnectionRow | undefined> {
		const rows = await executor
			.delete(oauthConnection)
			.where(
				and(
					eq(oauthConnection.organizationId, workspaceId),
					eq(oauthConnection.id, connectionId),
				),
			)
			.returning()
		return rows[0]
	},
}
