import { z } from "zod"

import { agentGraphSchema } from "./graph/types"

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
	/**
	 * A flow, when this version is one. Null keeps the version a single prompt,
	 * which is what every agent built before flows existed is.
	 *
	 * Validated structurally at publish time — a dangling edge is a mistake
	 * someone can fix while looking at the canvas, and the same mistake found
	 * mid-run is a failed run and a charged model call.
	 */
	graph: agentGraphSchema.nullable().default(null),
	/**
	 * Whether this version remembers anything between runs, and about whom.
	 *
	 * Off by default. Memory changes what an agent says without anybody editing
	 * its brief — right when it was asked for, baffling when it was not — so it
	 * is opted into per version and a version published without it behaves
	 * exactly as every version before memory existed did (ADR-055).
	 */
	memoryEnabled: z.boolean().default(false),
	/**
	 * `agent` remembers facts about the work, shared by everybody who runs it.
	 * `user` keeps each person's memories to themselves. There is deliberately no
	 * value that shares one person's memories with another.
	 */
	memoryScope: z.enum(["agent", "user"]).default("agent"),
	/** How many memories one run may recall. Bounded so recall cannot eat the prompt. */
	memoryTopK: z.number().int().min(1).max(20).default(5),
})

/**
 * Starting from a template. The brief, the tools and the settings come from the
 * template, so the only choices left are the ones only this workspace can make:
 * what to call it, which documents it answers from, and which project pays.
 */
export const createFromTemplateSchema = z.object({
	templateId: z.string().trim().min(1).max(64),
	name: z.string().trim().min(1).max(120).optional(),
	projectId: z.string().min(1).nullable().default(null),
	knowledgeBaseIds: z.array(z.string().min(1)).max(10).default([]),
})

export type CreateFromTemplateInput = z.infer<typeof createFromTemplateSchema>

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
	/**
	 * Images this run is about, uploaded through the same endpoint a chat message
	 * uses. Ten because a run is not a conversation: the whole set is one
	 * question, and a flow that wants more should read them from a spreadsheet
	 * rather than carry them on the request.
	 */
	attachmentIds: z.array(z.string().min(1)).max(10).optional(),
})

/** The answers a paused flow was waiting for, keyed by the field it asked for. */
export const resumeRunSchema = z.object({
	answers: z.record(z.string().min(1).max(60), z.string().max(4_000)),
})

export type AgentConfigInput = z.infer<typeof agentConfigSchema>
export type CreateAgentInput = z.infer<typeof createAgentSchema>
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>
export type RunAgentInput = z.infer<typeof runAgentSchema>
export type ResumeRunInput = z.infer<typeof resumeRunSchema>
