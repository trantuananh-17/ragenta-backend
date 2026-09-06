import { z } from "zod"

import { PARSER_IDS, parserConfigSchema } from "./parsers"

export const slugSchema = z
	.string()
	.trim()
	.min(2)
	.max(64)
	.regex(
		/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
		"Lower-case letters, digits and single hyphens.",
	)

const parserIdSchema = z.enum(PARSER_IDS as [string, ...string[]])

/**
 * Retrieval defaults for the base. Shared by create and update, and each of them
 * is safe to change at any time — unlike the chunking settings below, they are
 * read at query time and affect nothing that is already indexed.
 */
const retrievalDefaultsSchema = {
	topK: z.number().int().min(1).max(20).optional(),
	similarityThreshold: z.number().min(0).max(1).optional(),
	vectorWeight: z.number().min(0).max(1).optional(),
	rerank: z
		.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1) })
		.nullable()
		.optional(),
}

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
	/** Which chunking strategy the documents here are cut with. */
	parserId: parserIdSchema.default("general"),
	parserConfig: parserConfigSchema.default({}),
	...retrievalDefaultsSchema,
})

/**
 * Chunking settings *can* be changed, and changing one changes the digest every
 * ingestion task is keyed on — so the passages already indexed keep the shape
 * they were cut with until each document is re-indexed. That is stated in the
 * response rather than enforced by refusing the edit: a knowledge base whose
 * chunk size can never change is one that has to be rebuilt from scratch to
 * correct a bad first guess.
 */
export const updateKnowledgeBaseSchema = z
	.object({
		name: z.string().trim().min(2).max(120).optional(),
		description: z.string().trim().max(600).nullable().optional(),
		chunkTokenSize: z.number().int().min(64).max(2048).optional(),
		chunkOverlapPercent: z.number().int().min(0).max(50).optional(),
		parserId: parserIdSchema.optional(),
		parserConfig: parserConfigSchema.optional(),
		...retrievalDefaultsSchema,
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "Provide at least one field to change.",
	})

/**
 * Per-document overrides, sent as form fields alongside the upload. One scanned
 * appendix in an otherwise uniform base needs a different page range, not a
 * second knowledge base.
 */
export const uploadDocumentSchema = z.object({
	parserId: parserIdSchema.optional(),
	parserConfig: parserConfigSchema.optional(),
})

/** Re-index may also change the document's own overrides in the same call. */
export const reindexDocumentSchema = z
	.object({
		parserId: parserIdSchema.nullable().optional(),
		parserConfig: parserConfigSchema.nullable().optional(),
	})
	.default({})

export const listQuerySchema = z.object({
	status: z
		.enum([
			"pending",
			"parsing",
			"chunking",
			"embedding",
			"enriching",
			"summarising",
			"ready",
			"failed",
			"cancelled",
		])
		.optional(),
})

export type CreateKnowledgeBaseInput = z.infer<typeof createKnowledgeBaseSchema>
export type UpdateKnowledgeBaseInput = z.infer<typeof updateKnowledgeBaseSchema>
export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>
export type ReindexDocumentInput = z.infer<typeof reindexDocumentSchema>
