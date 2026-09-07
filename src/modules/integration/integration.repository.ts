import { and, asc, eq, inArray, isNull, or } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { integration } from "../../db/schema"

export type IntegrationRow = typeof integration.$inferSelect
export type NewIntegration = typeof integration.$inferInsert

/**
 * Every method takes the owner explicitly. `null` means the platform-wide rows
 * an administrator manages; a workspace id means that workspace's own.
 *
 * There is no unscoped read, update or delete in this file on purpose: the
 * owner is part of the `where`, so a caller cannot forget it and get another
 * tenant's credential back (`.claude/rules/security.md`).
 */
function ownedBy(organizationId: string | null) {
	return organizationId === null
		? isNull(integration.organizationId)
		: eq(integration.organizationId, organizationId)
}

export const integrationRepository = {
	/** One owner's connections. Platform-wide rows are not mixed into a workspace's list. */
	async listOwnedBy(organizationId: string | null, executor: DbExecutor = db) {
		return executor
			.select()
			.from(integration)
			.where(ownedBy(organizationId))
			.orderBy(asc(integration.id))
	},

	async findOwnedBy(
		id: string,
		organizationId: string | null,
		executor: DbExecutor = db,
	): Promise<IntegrationRow | undefined> {
		const rows = await executor
			.select()
			.from(integration)
			.where(and(eq(integration.id, id), ownedBy(organizationId)))
			.limit(1)
		return rows[0]
	},

	/**
	 * The rows a run may resolve a connection name against: the platform-wide
	 * ones plus this workspace's own, never another tenant's.
	 *
	 * The owner predicate is in the query rather than a filter afterwards, so a
	 * row belonging to someone else is never read in the first place — even
	 * though `ids` is derived from a name the model chose.
	 */
	async listResolvable(
		ids: string[],
		workspaceId: string | undefined,
		executor: DbExecutor = db,
	): Promise<IntegrationRow[]> {
		if (ids.length === 0) return []
		const owner = workspaceId
			? or(isNull(integration.organizationId), eq(integration.organizationId, workspaceId))
			: isNull(integration.organizationId)

		return executor
			.select()
			.from(integration)
			.where(and(inArray(integration.id, ids), owner))
	},

	/**
	 * The one method with no owner predicate, and it returns no credential data:
	 * it answers only "is this primary key already taken, and by whom", so a
	 * clashing id becomes a 409 instead of a constraint violation surfacing as a
	 * 500.
	 */
	async findOwner(
		id: string,
		executor: DbExecutor = db,
	): Promise<{ organizationId: string | null } | undefined> {
		const rows = await executor
			.select({ organizationId: integration.organizationId })
			.from(integration)
			.where(eq(integration.id, id))
			.limit(1)
		return rows[0]
	},

	async insert(values: NewIntegration, executor: DbExecutor = db): Promise<IntegrationRow> {
		const [row] = await executor.insert(integration).values(values).returning()
		return row!
	},

	async update(
		id: string,
		organizationId: string | null,
		values: Partial<NewIntegration>,
		executor: DbExecutor = db,
	): Promise<IntegrationRow | undefined> {
		const [row] = await executor
			.update(integration)
			.set(values)
			.where(and(eq(integration.id, id), ownedBy(organizationId)))
			.returning()
		return row
	},

	async remove(
		id: string,
		organizationId: string | null,
		executor: DbExecutor = db,
	): Promise<boolean> {
		const rows = await executor
			.delete(integration)
			.where(and(eq(integration.id, id), ownedBy(organizationId)))
			.returning({ id: integration.id })
		return rows.length > 0
	},

	/**
	 * Bookkeeping written after a call the owner check already passed, so it is
	 * keyed on the primary key alone.
	 */
	async touch(id: string, values: Partial<NewIntegration>, executor: DbExecutor = db) {
		await executor.update(integration).set(values).where(eq(integration.id, id))
	},
}
