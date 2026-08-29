import { z } from "zod"

const selectionSchema = z.object({
	provider: z.string().trim().min(1),
	model: z.string().trim().min(1),
})

/**
 * Both halves are optional so a client can change the chat model without
 * restating the embedding model, but at least one must be present — an empty
 * body silently doing nothing is a bug report waiting to happen.
 */
export const updateModelSettingsSchema = z
	.object({
		chat: selectionSchema.optional(),
		embedding: selectionSchema.optional(),
	})
	.refine((value) => value.chat !== undefined || value.embedding !== undefined, {
		message: "Provide a chat or an embedding selection.",
	})

export type UpdateModelSettingsInput = z.infer<typeof updateModelSettingsSchema>
