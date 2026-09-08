import { and, desc, eq, isNull } from "drizzle-orm"
import type { SQL } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { project } from "../../db/schema"

export type ProjectRow = typeof project.$inferSelect
export type NewProject = typeof project.$inferInsert

/**
 * Every method takes the workspace id and filters on it, including the ones that
 * already have a project id. Looking a project up by id alone would let a valid
 * id from another tenant through.
 */
export const projectRepository = {
	/**
	 * `visible` narrows the list to what the caller may actually open (ADR-054).
	 * It goes in the WHERE rather than being applied to the result, so the rows
	 * that come back are the rows that exist as far as this caller is concerned.
	 */
	async list(
		workspaceId: string,
		includeArchived: boolean,
		visible: SQL | undefined,
		executor: DbExecutor = db,
	) {
		const conditions = [eq(project.organizationId, workspaceId)]
		if (!includeArchived) conditions.push(isNull(project.archivedAt))
		if (visible) conditions.push(visible)

		return executor
			.select()
			.from(project)
			.where(and(...conditions))
			.orderBy(desc(project.createdAt))
	},

	async findById(workspaceId: string, projectId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(project)
			.where(and(eq(project.organizationId, workspaceId), eq(project.id, projectId)))
			.limit(1)
		return rows[0]
	},

	async findBySlug(workspaceId: string, slug: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(project)
			.where(and(eq(project.organizationId, workspaceId), eq(project.slug, slug)))
			.limit(1)
		return rows[0]
	},

	async insert(entry: NewProject, executor: DbExecutor = db) {
		const rows = await executor.insert(project).values(entry).returning()
		return rows[0]
	},

	async update(
		workspaceId: string,
		projectId: string,
		patch: Partial<Pick<ProjectRow, "name" | "description" | "archivedAt">>,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.update(project)
			.set(patch)
			.where(and(eq(project.organizationId, workspaceId), eq(project.id, projectId)))
			.returning()
		return rows[0]
	},

	async remove(workspaceId: string, projectId: string, executor: DbExecutor = db) {
		const rows = await executor
			.delete(project)
			.where(and(eq(project.organizationId, workspaceId), eq(project.id, projectId)))
			.returning({ id: project.id })
		return rows[0]
	},
}
