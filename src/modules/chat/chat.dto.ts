import { z } from "zod"

export const createConversationSchema = z.object({
	title: z.string().trim().min(1).max(200).default("New conversation"),
	projectId: z.string().min(1).nullable().default(null),
	/** Null means the model answers without retrieval. */
	knowledgeBaseId: z.string().min(1).nullable().default(null),
})

export const updateConversationSchema = z
	.object({
		title: z.string().trim().min(1).max(200).optional(),
		knowledgeBaseId: z.string().min(1).nullable().optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "Provide at least one field to change.",
	})

export const sendMessageSchema = z.object({
	content: z.string().trim().min(1).max(8000),
	/**
	 * Narrows retrieval to specific documents in the conversation's knowledge
	 * base. Empty means the whole base.
	 */
	documentIds: z.array(z.string().min(1)).max(50).optional(),
	/** Overrides the resolved chat model for this turn only. */
	model: z
		.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1) })
		.optional(),
	topK: z.number().int().min(1).max(20).optional(),
})

export type CreateConversationInput = z.infer<typeof createConversationSchema>
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>
export type SendMessageInput = z.infer<typeof sendMessageSchema>
