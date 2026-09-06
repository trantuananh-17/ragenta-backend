import { z } from "zod"

const modelSelectionSchema = z.object({
	provider: z.string().trim().min(1),
	model: z.string().trim().min(1),
})

/**
 * Everything one version configures.
 *
 * Publishing replaces the whole object rather than patching it: a version is
 * immutable (ADR-029), so "change only the temperature" is a new version with
 * every other field restated, and a partial body would make it ambiguous which
 * of the previous version's settings were meant to carry over.
 */
export const agentConfigSchema = z.object({
	instructions: z.string().trim().min(1).max(20_000),
	/** Null inherits the project override, then the workspace default. */
	model: modelSelectionSchema.nullable().default(null),
	/** Null sends no temperature at all, which is what a chat turn does. */
	temperature: z.number().min(0).max(2).nullable().default(null),
	maxOutputTokens: z.number().int().min(256).max(8_000).nullable().default(null),
	/** Empty means the agent answers without retrieval. */
	knowledgeBaseIds: z.array(z.string().min(1)).max(10).default([]),
	searchMode: z.enum(["hybrid", "vector", "keyword"]).default("hybrid"),
	/** Null inherits the knowledge base's own value, as a conversation does. */
	topK: z.number().int().min(1).max(20).nullable().default(null),
	similarityThreshold: z.number().min(0).max(1).nullable().default(null),
	vectorWeight: z.number().min(0).max(1).nullable().default(null),
	rerank: modelSelectionSchema.nullable().default(null),
	/**
	 * Which tools a run may call, by id. Validated against what this deployment
	 * actually has — an unknown id is a typo that would otherwise become an agent
	 * silently missing a capability its author thought it had.
	 */
	tools: z.array(z.string().trim().min(1)).max(8).default([]),
	/**
	 * How many model↔tool rounds one run may take. 1 means no loop: the model
	 * answers once and any tool call it makes is not executed.
	 */
	maxRounds: z.number().int().min(1).max(10).default(1),
	/**
	 * The most credits one run may spend before it is stopped. Null bounds the run
	 * by `maxRounds` alone, which says nothing about cost.
	 */
	creditCeiling: z.number().min(0).nullable().default(null),
	/**
	 * On by default for the same reason chat defaults to it: an agent that
	 * quietly falls back to the model's own memory is the failure this product
	 * exists to avoid. Ignored by an agent with no knowledge base.
	 */
	groundedOnly: z.boolean().default(true),
})

export const createAgentSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).nullable().default(null),
	/** Attribution: a run's spend is reported under this project. */
	projectId: z.string().min(1).nullable().default(null),
	config: agentConfigSchema,
})

/**
 * Identity and lifecycle only. The configuration is never patched — it is
 * republished as a new version.
 */
export const updateAgentSchema = z
	.object({
		name: z.string().trim().min(1).max(120).optional(),
		description: z.string().trim().max(500).nullable().optional(),
		projectId: z.string().min(1).nullable().optional(),
		status: z.enum(["draft", "active", "archived"]).optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "Provide at least one field to change.",
	})

export const runAgentSchema = z.object({
	input: z.string().trim().min(1).max(8_000),
	/**
	 * Narrows retrieval to specific documents in the agent's knowledge bases.
	 * Empty means every document in them.
	 */
	documentIds: z.array(z.string().min(1)).max(50).optional(),
})

export type AgentConfigInput = z.infer<typeof agentConfigSchema>
export type CreateAgentInput = z.infer<typeof createAgentSchema>
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>
export type RunAgentInput = z.infer<typeof runAgentSchema>
