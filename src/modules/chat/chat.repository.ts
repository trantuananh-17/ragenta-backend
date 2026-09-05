import { and, asc, count, desc, eq } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { conversation, knowledgeBase, message } from "../../db/schema"
import type { PaginationQuery } from "../../shared/pagination"

export type ConversationRow = typeof conversation.$inferSelect
export type MessageRow = typeof message.$inferSelect

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
