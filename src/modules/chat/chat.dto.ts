import { z } from "zod"

/**
 * Retrieval settings, shared by create and update.
 *
 * Every one of them is optional and null-able, and null means "inherit the
 * knowledge base". RAGFlow keeps the same set on its assistant; the reason they
 * are per conversation here rather than only per base is that one thread may be
 * looking for an exact error code — keyword mode, high threshold — in a base
 * that is otherwise queried in natural language.
 */
const retrievalSettingsSchema = {
	searchMode: z.enum(["hybrid", "vector", "keyword"]).optional(),
	topK: z.number().int().min(1).max(20).nullable().optional(),
	similarityThreshold: z.number().min(0).max(1).nullable().optional(),
	vectorWeight: z.number().min(0).max(1).nullable().optional(),
	rerank: z
		.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1) })
		.nullable()
		.optional(),
	/**
	 * Answer only from the retrieved documents. Ignored by a thread with no
	 * knowledge base — there is nothing to be grounded in — and on by default,
	 * because a citation-bearing product that quietly falls back to the model's
	 * own memory is the failure mode this whole feature exists to avoid.
	 */
	groundedOnly: z.boolean().optional(),
	/** Rewrite a follow-up into a standalone question before searching. */
	refineFollowUps: z.boolean().optional(),
}

export const createConversationSchema = z.object({
	title: z.string().trim().min(1).max(200).default("New conversation"),
	/**
	 * Which project this thread's spend is attributed to, and whose chat-model
	 * override applies. Null is legitimate — a workspace may not use projects.
	 */
	projectId: z.string().min(1).nullable().default(null),
	/** Null means the model answers without retrieval. */
	knowledgeBaseId: z.string().min(1).nullable().default(null),
	/**
	 * Bases searched alongside the primary one. All of them must share its
	 * embedding model — passages from two models cannot be ranked against each
	 * other — and the service refuses the combination rather than mis-ranking it.
	 */
	additionalKnowledgeBaseIds: z.array(z.string().min(1)).max(10).default([]),
	...retrievalSettingsSchema,
})

export const updateConversationSchema = z
	.object({
		title: z.string().trim().min(1).max(200).optional(),
		projectId: z.string().min(1).nullable().optional(),
		knowledgeBaseId: z.string().min(1).nullable().optional(),
		additionalKnowledgeBaseIds: z.array(z.string().min(1)).max(10).optional(),
		...retrievalSettingsSchema,
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "Provide at least one field to change.",
	})

export const sendMessageSchema = z.object({
	content: z.string().trim().min(1).max(8000),
	/**
	 * Narrows retrieval to specific documents in the conversation's knowledge
	 * bases. Empty means every document in them.
	 */
	documentIds: z.array(z.string().min(1)).max(50).optional(),
	/** Overrides the resolved chat model for this turn only. */
	model: z
		.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1) })
		.optional(),
	/** Per-turn overrides of the thread's retrieval settings. */
	topK: z.number().int().min(1).max(20).optional(),
	searchMode: z.enum(["hybrid", "vector", "keyword"]).optional(),
	similarityThreshold: z.number().min(0).max(1).optional(),
	vectorWeight: z.number().min(0).max(1).optional(),
})

export type CreateConversationInput = z.infer<typeof createConversationSchema>
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>
export type SendMessageInput = z.infer<typeof sendMessageSchema>
