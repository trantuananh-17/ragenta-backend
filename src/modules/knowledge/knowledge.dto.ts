import { z } from "zod"

export const slugSchema = z
	.string()
	.trim()
	.min(2)
	.max(64)
	.regex(
		/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
		"Lower-case letters, digits and single hyphens.",
	)

export const createKnowledgeBaseSchema = z.object({
	name: z.string().trim().min(2).max(120),
	slug: slugSchema.optional(),
	description: z.string().trim().max(600).nullable().default(null),
	/**
	 * Optional: a knowledge base falls back to the workspace's embedding setting.
	 * Whatever it resolves to is frozen on the row — see the schema comment.
	 */
	embedding: z
		.object({
			provider: z.string().trim().min(1),
			model: z.string().trim().min(1),
		})
		.optional(),
	chunkTokenSize: z.number().int().min(64).max(2048).default(512),
	chunkOverlapPercent: z.number().int().min(0).max(50).default(15),
})

/**
 * Chunking parameters are deliberately absent: changing them would only affect
 * documents ingested afterwards, leaving one knowledge base holding passages cut
 * two different ways. Re-ingesting every document is the honest way to change
 * them, and that is a different operation from editing a name.
 */
export const updateKnowledgeBaseSchema = z
	.object({
		name: z.string().trim().min(2).max(120).optional(),
		description: z.string().trim().max(600).nullable().optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "Provide at least one field to change.",
	})

export const listQuerySchema = z.object({
	status: z.enum(["pending", "parsing", "chunking", "embedding", "ready", "failed"]).optional(),
})

export type CreateKnowledgeBaseInput = z.infer<typeof createKnowledgeBaseSchema>
export type UpdateKnowledgeBaseInput = z.infer<typeof updateKnowledgeBaseSchema>
