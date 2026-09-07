import { and, eq, isNull } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { messageAttachment } from "../../db/schema"

export type MessageAttachmentRow = typeof messageAttachment.$inferSelect
export type NewMessageAttachment = typeof messageAttachment.$inferInsert

/**
 * Every method takes the workspace id and puts it in the WHERE clause, even
 * where the primary key alone would be unique — the tenant boundary belongs
 * where a handler cannot forget it.
 */
export const attachmentRepository = {
	async insert(entry: NewMessageAttachment, executor: DbExecutor = db) {
		const rows = await executor.insert(messageAttachment).values(entry).returning()
		return rows[0]
	},

	async find(workspaceId: string, attachmentId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(messageAttachment)
			.where(
				and(
					eq(messageAttachment.organizationId, workspaceId),
					eq(messageAttachment.id, attachmentId),
				),
			)
			.limit(1)
		return rows[0]
	},

	/**
	 * Extraction results and the status around them. Workspace-scoped like every
	 * other statement here, so a job that lost track of which tenant it is in
	 * cannot write across one.
	 */
	async update(
		workspaceId: string,
		attachmentId: string,
		patch: Partial<NewMessageAttachment>,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.update(messageAttachment)
			.set(patch)
			.where(
				and(
					eq(messageAttachment.organizationId, workspaceId),
					eq(messageAttachment.id, attachmentId),
				),
			)
			.returning()
		return rows[0]
	},

	/**
	 * `message_id is null` is part of the statement rather than a check the caller
	 * makes first: a send can bind the row between reading it and deleting it, and
	 * the delete has to lose that race instead of leaving the message pointing at
	 * an object that is gone.
	 */
	async deleteUnbound(workspaceId: string, attachmentId: string, executor: DbExecutor = db) {
		const rows = await executor
			.delete(messageAttachment)
			.where(
				and(
					eq(messageAttachment.organizationId, workspaceId),
					eq(messageAttachment.id, attachmentId),
					isNull(messageAttachment.messageId),
				),
			)
			.returning({ id: messageAttachment.id })
		return rows.length > 0
	},
}
