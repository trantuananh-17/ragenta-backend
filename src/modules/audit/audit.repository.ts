import { and, count, desc, eq } from "drizzle-orm"
import type { SQL } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { auditLog } from "../../db/schema"
import type { PaginationQuery } from "../../shared/pagination"

export type AuditLogRow = typeof auditLog.$inferSelect
export type NewAuditLog = typeof auditLog.$inferInsert

export interface AuditFilter {
	organizationId?: string
	actorId?: string
	action?: string
}

export const auditRepository = {
	async insert(entry: NewAuditLog, executor: DbExecutor = db) {
		await executor.insert(auditLog).values(entry)
	},

	async list(filter: AuditFilter, query: PaginationQuery, executor: DbExecutor = db) {
		const conditions: SQL[] = []
		if (filter.organizationId) {
			conditions.push(eq(auditLog.organizationId, filter.organizationId))
		}
		if (filter.actorId) conditions.push(eq(auditLog.actorId, filter.actorId))
		if (filter.action) conditions.push(eq(auditLog.action, filter.action))
		const where = conditions.length > 0 ? and(...conditions) : undefined

		const items = await executor
			.select()
			.from(auditLog)
			.where(where)
			.orderBy(desc(auditLog.createdAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor.select({ value: count() }).from(auditLog).where(where)

		return { items, total: totals?.value ?? 0 }
	},
}
