import { and, asc, eq, isNotNull } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { dataQuery, dataSource } from "../../db/schema"

export type DataSourceRow = typeof dataSource.$inferSelect
export type DataQueryRow = typeof dataQuery.$inferSelect

/**
 * Every read is workspace-scoped. A data source holds a credential to somebody
 * else's database, so a query that could return another tenant's row is the
 * worst mistake available in this module.
 */
export const datasourceRepository = {
	async listSources(workspaceId: string, executor: DbExecutor = db): Promise<DataSourceRow[]> {
		return executor
			.select()
			.from(dataSource)
			.where(eq(dataSource.organizationId, workspaceId))
			.orderBy(asc(dataSource.name))
	},

	async findSource(
		workspaceId: string,
		sourceId: string,
		executor: DbExecutor = db,
	): Promise<DataSourceRow | undefined> {
		const rows = await executor
			.select()
			.from(dataSource)
			.where(and(eq(dataSource.organizationId, workspaceId), eq(dataSource.id, sourceId)))
			.limit(1)
		return rows[0]
	},

	async findSourceByName(
		workspaceId: string,
		name: string,
		executor: DbExecutor = db,
	): Promise<DataSourceRow | undefined> {
		const rows = await executor
			.select()
			.from(dataSource)
			.where(and(eq(dataSource.organizationId, workspaceId), eq(dataSource.name, name)))
			.limit(1)
		return rows[0]
	},

	async upsertSource(
		row: typeof dataSource.$inferInsert,
		executor: DbExecutor = db,
	): Promise<void> {
		await executor
			.insert(dataSource)
			.values(row)
			.onConflictDoUpdate({ target: dataSource.id, set: row })
	},

	async updateSource(
		sourceId: string,
		fields: Partial<typeof dataSource.$inferInsert>,
		executor: DbExecutor = db,
	): Promise<void> {
		await executor.update(dataSource).set(fields).where(eq(dataSource.id, sourceId))
	},

	async removeSource(sourceId: string, executor: DbExecutor = db): Promise<void> {
		await executor.delete(dataSource).where(eq(dataSource.id, sourceId))
	},

	async listQueries(
		workspaceId: string,
		sourceId: string,
		executor: DbExecutor = db,
	): Promise<DataQueryRow[]> {
		return executor
			.select()
			.from(dataQuery)
			.where(
				and(eq(dataQuery.organizationId, workspaceId), eq(dataQuery.dataSourceId, sourceId)),
			)
			.orderBy(asc(dataQuery.name))
	},

	/**
	 * What an agent may call: approved, on an enabled source.
	 *
	 * The `approved_at is not null` is in the statement rather than checked
	 * afterwards — that column is the entire gate between a model's proposal and
	 * SQL running against a customer's database.
	 */
	async listApprovedQueries(
		workspaceId: string,
		executor: DbExecutor = db,
	): Promise<(DataQueryRow & { sourceName: string })[]> {
		const rows = await executor
			.select({ query: dataQuery, sourceName: dataSource.name })
			.from(dataQuery)
			.innerJoin(dataSource, eq(dataSource.id, dataQuery.dataSourceId))
			.where(
				and(
					eq(dataQuery.organizationId, workspaceId),
					isNotNull(dataQuery.approvedAt),
					eq(dataSource.enabled, true),
				),
			)
			.orderBy(asc(dataQuery.name))

		return rows.map((row) => ({ ...row.query, sourceName: row.sourceName }))
	},

	async findApprovedQueryByName(
		workspaceId: string,
		name: string,
		executor: DbExecutor = db,
	): Promise<DataQueryRow | undefined> {
		const rows = await executor
			.select()
			.from(dataQuery)
			.where(
				and(
					eq(dataQuery.organizationId, workspaceId),
					eq(dataQuery.name, name),
					isNotNull(dataQuery.approvedAt),
				),
			)
			.limit(1)
		return rows[0]
	},

	async findQuery(
		workspaceId: string,
		queryId: string,
		executor: DbExecutor = db,
	): Promise<DataQueryRow | undefined> {
		const rows = await executor
			.select()
			.from(dataQuery)
			.where(and(eq(dataQuery.organizationId, workspaceId), eq(dataQuery.id, queryId)))
			.limit(1)
		return rows[0]
	},

	async findQueryByName(
		sourceId: string,
		name: string,
		executor: DbExecutor = db,
	): Promise<DataQueryRow | undefined> {
		const rows = await executor
			.select()
			.from(dataQuery)
			.where(and(eq(dataQuery.dataSourceId, sourceId), eq(dataQuery.name, name)))
			.limit(1)
		return rows[0]
	},

	async upsertQuery(row: typeof dataQuery.$inferInsert, executor: DbExecutor = db): Promise<void> {
		await executor
			.insert(dataQuery)
			.values(row)
			.onConflictDoUpdate({ target: dataQuery.id, set: row })
	},

	async removeQuery(queryId: string, executor: DbExecutor = db): Promise<void> {
		await executor.delete(dataQuery).where(eq(dataQuery.id, queryId))
	},

	async touchQuery(queryId: string, executor: DbExecutor = db): Promise<void> {
		await executor.update(dataQuery).set({ lastRunAt: new Date() }).where(eq(dataQuery.id, queryId))
	},
}
