import { eq } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { workspaceSettings } from "../../db/schema"

export type WorkspaceSettingsRow = typeof workspaceSettings.$inferSelect

export const modelRepository = {
	async findSettings(workspaceId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(workspaceSettings)
			.where(eq(workspaceSettings.organizationId, workspaceId))
			.limit(1)
		return rows[0]
	},

	/**
	 * A workspace has at most one settings row and it is created on first write,
	 * so this is an upsert rather than a create/update pair.
	 */
	async upsertSettings(
		workspaceId: string,
		values: Pick<
			WorkspaceSettingsRow,
			"chatProvider" | "chatModel" | "embeddingProvider" | "embeddingModel"
		>,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.insert(workspaceSettings)
			.values({ organizationId: workspaceId, ...values })
			.onConflictDoUpdate({
				target: workspaceSettings.organizationId,
				set: values,
			})
			.returning()
		return rows[0]
	},
}
