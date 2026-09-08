import type { z } from "zod"

import type { ToolDefinition } from "../../../ai/clients"
import type { ModelSelection } from "../../model/model.service"

/**
 * What a tool is allowed to know about the run that called it.
 *
 * Deliberately small: a workspace, the run it belongs to and who started it.
 * A tool never receives a session, a request or a database handle — anything it
 * needs beyond this belongs to a domain service it calls, which does its own
 * workspace scoping (`.claude/rules/security.md`).
 */
export interface ToolContext {
	workspaceId: string
	projectId: string | null
	userId: string | null
	runId: string
	/** Which step of the run this call is, for the usage reference it writes. */
	stepSeq: number
	/**
	 * The model the run itself is configured for, where it has one.
	 *
	 * A tool that calls a provider spends on this rather than on whatever the
	 * workspace is set to: an agent given a vision model was given it for its
	 * image step, and running that step on the workspace's chat model answers
	 * about the picture on a model nobody chose — and refuses for reasons about a
	 * model nobody chose either. Absent for a caller with no run behind it, which
	 * leaves the workspace's own model as the answer.
	 */
	model?: ModelSelection
	signal?: AbortSignal
}

/**
 * What a tool gives back to the model.
 *
 * `content` is text, because that is what every provider's tool-result shape
 * accepts and what the model actually reads. `ok: false` is not an exception:
 * a tool that failed should tell the model so it can try something else, and
 * throwing would end a run that is still perfectly able to continue.
 */
export interface ToolResult {
	ok: boolean
	content: string
	/** Kept on the run step for the timeline, never sent to the model. */
	metadata?: Record<string, unknown>
	/** Provider spend this tool caused, to be charged by the runner. */
	usage?: {
		provider: string
		model: string
		inputTokens: number
		outputTokens: number
		operation: "embedding" | "rerank" | "agent"
	}
}

export interface AgentTool {
	name: string
	/**
	 * The schema to show the model, when it is not this tool's own.
	 *
	 * Set only by the MCP bridge, which passes a third-party server's JSON Schema
	 * through untranslated: rebuilding somebody else's schema in zod would mean
	 * being confidently wrong about what their tool accepts. Every built-in tool
	 * leaves this unset and its schema is derived from `parameters`, so the two
	 * cannot drift.
	 */
	jsonSchema?: Record<string, unknown>
	/** What the model is told the tool does. This is the whole of its API docs. */
	description: string
	/** Validated against, and turned into the JSON Schema the model is given. */
	parameters: z.ZodType
	/**
	 * True when the tool changes something outside Ragenta.
	 *
	 * It is what the approval gate keys on: a tool that only reads can be got
	 * wrong and cost a little, while one that sends an email or POSTs to a
	 * customer's system gets it wrong once and it has happened (ADR-032).
	 */
	writes?: boolean
	execute(context: ToolContext, args: unknown): Promise<ToolResult>
}

/** The tool as a provider needs to see it. */
export type { ToolDefinition }
