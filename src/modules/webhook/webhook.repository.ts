import { and, asc, desc, eq, inArray, lt } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { webhookDelivery, webhookEndpoint } from "../../db/schema"

export type WebhookEndpointRow = typeof webhookEndpoint.$inferSelect
export type WebhookDeliveryRow = typeof webhookDelivery.$inferSelect

export const webhookRepository = {
	async list(workspaceId: string, executor: DbExecutor = db): Promise<WebhookEndpointRow[]> {
		return executor
			.select()
			.from(webhookEndpoint)
			.where(eq(webhookEndpoint.organizationId, workspaceId))
			.orderBy(asc(webhookEndpoint.name))
	},

	/**
	 * The fan-out's read: the enabled endpoints of one workspace.
	 *
	 * Subscription filtering happens in Node rather than in SQL. The list is a
	 * jsonb array of a handful of keys over a handful of rows, so a containment
	 * query would buy nothing and cost an index nobody else needs.
	 */
	async listEnabled(
		workspaceId: string,
		executor: DbExecutor = db,
	): Promise<WebhookEndpointRow[]> {
		return executor
			.select()
			.from(webhookEndpoint)
			.where(
				and(
					eq(webhookEndpoint.organizationId, workspaceId),
					eq(webhookEndpoint.enabled, true),
				),
			)
	},

	async findScoped(
		workspaceId: string,
		endpointId: string,
		executor: DbExecutor = db,
	): Promise<WebhookEndpointRow | undefined> {
		const rows = await executor
			.select()
			.from(webhookEndpoint)
			.where(
				and(
					eq(webhookEndpoint.organizationId, workspaceId),
					eq(webhookEndpoint.id, endpointId),
				),
			)
			.limit(1)
		return rows[0]
	},

	/**
	 * By id alone, for the delivery job.
	 *
	 * The one read here with no workspace filter, and it is safe for the reason
	 * the widget's key lookup is: the job was created by a fan-out that had
	 * already resolved the workspace, and the row it names carries that workspace
	 * on it.
	 */
	async findById(
		endpointId: string,
		executor: DbExecutor = db,
	): Promise<WebhookEndpointRow | undefined> {
		const rows = await executor
			.select()
			.from(webhookEndpoint)
			.where(eq(webhookEndpoint.id, endpointId))
			.limit(1)
		return rows[0]
	},

	async insert(
		row: typeof webhookEndpoint.$inferInsert,
		executor: DbExecutor = db,
	): Promise<void> {
		await executor.insert(webhookEndpoint).values(row)
	},

	async update(
		endpointId: string,
		values: Partial<typeof webhookEndpoint.$inferInsert>,
		executor: DbExecutor = db,
	): Promise<void> {
		await executor
			.update(webhookEndpoint)
			.set(values)
			.where(eq(webhookEndpoint.id, endpointId))
	},

	async remove(endpointId: string, executor: DbExecutor = db): Promise<void> {
		await executor.delete(webhookEndpoint).where(eq(webhookEndpoint.id, endpointId))
	},

	async insertDelivery(
		row: typeof webhookDelivery.$inferInsert,
		executor: DbExecutor = db,
	): Promise<void> {
		await executor.insert(webhookDelivery).values(row)
	},

	async listDeliveries(
		workspaceId: string,
		endpointId: string | undefined,
		limit: number,
		executor: DbExecutor = db,
	): Promise<WebhookDeliveryRow[]> {
		return executor
			.select()
			.from(webhookDelivery)
			.where(
				endpointId
					? and(
							eq(webhookDelivery.organizationId, workspaceId),
							eq(webhookDelivery.endpointId, endpointId),
						)
					: eq(webhookDelivery.organizationId, workspaceId),
			)
			.orderBy(desc(webhookDelivery.createdAt))
			.limit(limit)
	},

	/**
	 * Drops delivery rows past the retention window, a bounded batch at a time —
	 * the same shape as the provider error sweep and for the same reason: this
	 * table grows with traffic, and one unbounded delete would lock the table the
	 * customer's own delivery log reads.
	 */
	async pruneDeliveriesOlderThan(
		cutoff: Date,
		batch: number,
		executor: DbExecutor = db,
	): Promise<number> {
		const doomed = executor
			.select({ id: webhookDelivery.id })
			.from(webhookDelivery)
			.where(lt(webhookDelivery.createdAt, cutoff))
			.limit(batch)

		const deleted = await executor
			.delete(webhookDelivery)
			.where(inArray(webhookDelivery.id, doomed))
			.returning({ id: webhookDelivery.id })

		return deleted.length
	},
}
