import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import {
	conversation,
	conversationKnowledgeBase,
	knowledgeBase,
	message,
	messageAttachment,
} from "../../db/schema"
import type { PaginationQuery } from "../../shared/pagination"

export type ConversationRow = typeof conversation.$inferSelect
export type MessageRow = typeof message.$inferSelect
/**
 * `message_attachment` is read and written from here as well as from the
 * attachment module, which owns uploading and deleting. Binding is the one
 * operation only a send can perform — it needs the message id, which does not
 * exist until the turn is written — and it belongs in the same transaction as
 * that write, so it lives beside it rather than behind a call the attachment
 * service would have to expose for one caller.
 */
export type AttachmentRow = typeof messageAttachment.$inferSelect

export const chatRepository = {
	async listConversations(
		workspaceId: string,
		query: PaginationQuery,
		executor: DbExecutor = db,
	) {
		const items = await executor
			.select({
				conversation,
				knowledgeBaseName: knowledgeBase.name,
			})
			.from(conversation)
			.leftJoin(knowledgeBase, eq(knowledgeBase.id, conversation.knowledgeBaseId))
			.where(eq(conversation.organizationId, workspaceId))
			.orderBy(desc(conversation.lastMessageAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor
			.select({ value: count() })
			.from(conversation)
			.where(eq(conversation.organizationId, workspaceId))

		return { items, total: totals?.value ?? 0 }
	},

	async findConversation(
		workspaceId: string,
		conversationId: string,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.select()
			.from(conversation)
			.where(
				and(
					eq(conversation.organizationId, workspaceId),
					eq(conversation.id, conversationId),
				),
			)
			.limit(1)
		return rows[0]
	},

	async insertConversation(
		entry: typeof conversation.$inferInsert,
		executor: DbExecutor = db,
	) {
		const rows = await executor.insert(conversation).values(entry).returning()
		return rows[0]
	},

	async updateConversation(
		workspaceId: string,
		conversationId: string,
		patch: Partial<typeof conversation.$inferInsert>,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.update(conversation)
			.set(patch)
			.where(
				and(
					eq(conversation.organizationId, workspaceId),
					eq(conversation.id, conversationId),
				),
			)
			.returning()
		return rows[0]
	},

	async deleteConversation(
		workspaceId: string,
		conversationId: string,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.delete(conversation)
			.where(
				and(
					eq(conversation.organizationId, workspaceId),
					eq(conversation.id, conversationId),
				),
			)
			.returning({ id: conversation.id })
		return rows.length > 0
	},

	/**
	 * The additional knowledge bases a conversation searches, beyond its primary
	 * one. Returned as ids only — the caller reads each base to check ownership
	 * and to compare embedding models, and a join here would return rows it would
	 * then have to re-read anyway.
	 */
	async listConversationBaseIds(conversationId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select({ knowledgeBaseId: conversationKnowledgeBase.knowledgeBaseId })
			.from(conversationKnowledgeBase)
			.where(eq(conversationKnowledgeBase.conversationId, conversationId))
		return rows.map((row) => row.knowledgeBaseId)
	},

	/** Replaces the set. One transaction, so a half-written set is never queried. */
	async setConversationBaseIds(
		conversationId: string,
		knowledgeBaseIds: string[],
		executor: DbExecutor = db,
	) {
		await executor.transaction(async (tx) => {
			await tx
				.delete(conversationKnowledgeBase)
				.where(eq(conversationKnowledgeBase.conversationId, conversationId))
			if (knowledgeBaseIds.length > 0) {
				await tx
					.insert(conversationKnowledgeBase)
					.values(knowledgeBaseIds.map((knowledgeBaseId) => ({ conversationId, knowledgeBaseId })))
			}
		})
	},

	/** Oldest first: the order a transcript is read in and the order a prompt needs. */
	async listMessages(
		workspaceId: string,
		conversationId: string,
		query: PaginationQuery,
		executor: DbExecutor = db,
	) {
		const where = and(
			eq(message.organizationId, workspaceId),
			eq(message.conversationId, conversationId),
		)

		const items = await executor
			.select()
			.from(message)
			.where(where)
			.orderBy(asc(message.createdAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor.select({ value: count() }).from(message).where(where)

		return { items, total: totals?.value ?? 0 }
	},

	/**
	 * The tail of the thread, for prompt history. Read newest-first with a limit
	 * and reversed by the caller — a conversation of a thousand turns should not
	 * be loaded to use the last ten.
	 */
	async listRecentMessages(
		conversationId: string,
		limit: number,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.select()
			.from(message)
			.where(eq(message.conversationId, conversationId))
			.orderBy(desc(message.createdAt))
			.limit(limit)
		return rows.reverse()
	},

	async insertMessage(entry: typeof message.$inferInsert, executor: DbExecutor = db) {
		const rows = await executor.insert(message).values(entry).returning()
		return rows[0]
	},

	/**
	 * Claims uploaded attachments for the message that was just written.
	 *
	 * `message_id is null` is part of the statement rather than a check the
	 * caller makes first, exactly as the attachment repository's delete has it:
	 * an id is single-use, and two sends racing on the same one must produce one
	 * winner rather than two messages pointing at the same image. The ids that
	 * were actually claimed come back so the caller can tell which it lost.
	 */
	async bindAttachments(
		workspaceId: string,
		conversationId: string,
		messageId: string,
		attachmentIds: string[],
		executor: DbExecutor = db,
	) {
		if (attachmentIds.length === 0) return []
		const rows = await executor
			.update(messageAttachment)
			.set({ conversationId, messageId })
			.where(
				and(
					eq(messageAttachment.organizationId, workspaceId),
					inArray(messageAttachment.id, attachmentIds),
					isNull(messageAttachment.messageId),
				),
			)
			.returning({ id: messageAttachment.id })
		return rows.map((row) => row.id)
	},

	/** What a set of messages carries, oldest first. Empty in returns empty out. */
	async listAttachmentsForMessages(
		workspaceId: string,
		messageIds: string[],
		executor: DbExecutor = db,
	): Promise<AttachmentRow[]> {
		if (messageIds.length === 0) return []
		return executor
			.select()
			.from(messageAttachment)
			.where(
				and(
					eq(messageAttachment.organizationId, workspaceId),
					inArray(messageAttachment.messageId, messageIds),
				),
			)
			.orderBy(asc(messageAttachment.createdAt))
	},

	async updateMessage(
		messageId: string,
		patch: Partial<typeof message.$inferInsert>,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.update(message)
			.set(patch)
			.where(eq(message.id, messageId))
			.returning()
		return rows[0]
	},
}
