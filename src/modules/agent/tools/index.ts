import { z } from "zod"

import type { ToolDefinition } from "../../../ai/clients"
import type { CitationCollector } from "../citations"
import { httpRequestTool } from "./http-request.tool"
import { createKnowledgeSearchTool } from "./knowledge-search.tool"
import type { AgentTool } from "./types"

export type { AgentTool, ToolContext, ToolResult } from "./types"

/**
 * The tools this deployment can run, and what a version may name.
 *
 * A stable id list rather than a free-form string: `agent_version.tools` stores
 * these ids, an unknown one is refused when the version is published, and the
 * set a run may call is built from the version — never from the request and
 * never from anything the model produced (ADR-029, `.claude/rules/security.md`).
 */
export const TOOL_IDS = ["knowledge_search", "http_request"] as const
export type ToolId = (typeof TOOL_IDS)[number]

export function isToolId(value: string): value is ToolId {
	return (TOOL_IDS as readonly string[]).includes(value)
}

/** What a version's tool list means, for the screen that offers it. */
export const TOOL_CATALOGUE: Record<ToolId, { title: string; description: string }> = {
	knowledge_search: {
		title: "Knowledge search",
		description:
			"Search the agent's own knowledge bases. The agent chooses when and what to search, and may search several times.",
	},
	http_request: {
		title: "Fetch a URL",
		description:
			"Read a public web page or HTTP API. Private and internal addresses are blocked, and responses are capped.",
	},
}

/**
 * The tools one run may call, built from the version it is executing.
 *
 * `knowledge_search` is closed over the version's knowledge bases and the run's
 * citation numbering rather than taking either as an argument, so the model can
 * neither reach a base it was not given nor renumber what it has already cited.
 */
export function toolsFor(
	ids: string[],
	knowledgeBaseIds: string[],
	citations: CitationCollector,
): AgentTool[] {
	const tools: AgentTool[] = []
	for (const id of ids) {
		if (id === "knowledge_search") {
			tools.push(createKnowledgeSearchTool(knowledgeBaseIds, citations))
		}
		if (id === "http_request") tools.push(httpRequestTool)
	}
	return tools
}

/**
 * The tool as the provider needs it.
 *
 * The schema the model is shown is derived from the schema its arguments are
 * validated against, so the two cannot drift — the same call `openapi.ts` makes
 * for request bodies.
 */
export function toDefinition(tool: AgentTool): ToolDefinition {
	return {
		name: tool.name,
		description: tool.description,
		parameters: z.toJSONSchema(tool.parameters, {
			io: "input",
			unrepresentable: "any",
		}) as Record<string, unknown>,
	}
}
