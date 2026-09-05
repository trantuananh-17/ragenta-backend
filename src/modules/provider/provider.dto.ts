import { z } from "zod"

/**
 * The key is write-only over the wire: it goes in and never comes back out. A
 * response carries the masked hint instead, which is also all the admin console
 * ever renders.
 */
export const saveCredentialSchema = z.object({
	apiKey: z.string().trim().min(8).max(400),
	/**
	 * Optional host override for gateways and self-hosted servers. Constrained to
	 * http(s) so a stored credential cannot be aimed at a file:// or a scheme the
	 * fetch layer would treat differently.
	 */
	baseUrl: z.url().startsWith("http").max(300).nullable().optional(),
})

const rateSchema = z.number().nonnegative().max(10_000)

export const upsertModelSchema = z.object({
	provider: z.string().trim().min(1).max(64),
	model: z.string().trim().min(1).max(160),
	capability: z.enum(["chat", "embedding"]),
	tier: z.enum(["economy", "premium"]),
	contextWindow: z.number().int().positive().max(10_000_000).nullable().default(null),
	inputPerMillion: rateSchema.default(0),
	outputPerMillion: rateSchema.default(0),
	embeddingPerMillion: rateSchema.default(0),
	/** Required for an embedding model: it selects the vector collection. */
	embeddingDimensions: z.number().int().positive().max(16_384).nullable().default(null),
	enabled: z.boolean().default(true),
})

/** Everything on a model can be edited except which model it is. */
export const patchModelSchema = upsertModelSchema
	.omit({ provider: true, model: true })
	.partial()
	.refine((value) => Object.keys(value).length > 0, {
		message: "Provide at least one field to change.",
	})

const selectionSchema = z.object({
	provider: z.string().trim().min(1),
	model: z.string().trim().min(1),
})

export const setPlatformDefaultsSchema = z.object({
	chat: selectionSchema,
	embedding: selectionSchema,
})

export type SaveCredentialInput = z.infer<typeof saveCredentialSchema>
export type UpsertModelInput = z.infer<typeof upsertModelSchema>
export type PatchModelInput = z.infer<typeof patchModelSchema>
export type SetPlatformDefaultsInput = z.infer<typeof setPlatformDefaultsSchema>
