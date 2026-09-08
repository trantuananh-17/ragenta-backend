import { z } from "zod"

import type { ToolDefinition } from "../../../ai/clients"
import type { CitationCollector } from "../citations"
import { apiCallTool } from "./api-call.tool"
import { APP_TOOLS } from "./app.tool"
import { browserReadTool } from "./browser.tool"
import { excelReadTool, excelWriteTool } from "./excel.tool"
import { GOOGLE_TOOLS } from "./google.tool"
import { httpRequestTool } from "./http-request.tool"
import { imageOcrTool } from "./image-ocr.tool"
import { imageVisionTool } from "./image-vision.tool"
import { createKnowledgeSearchTool } from "./knowledge-search.tool"
import { createMemoryTools } from "./memory.tool"
import { createSaveDocumentTool } from "./save-document.tool"
import { sendEmailTool } from "./send-email.tool"
import { speechSynthesizeTool } from "./speech-synthesize.tool"
import { speechTranscribeTool } from "./speech-transcribe.tool"
import { webSearchTool } from "./web-search.tool"
import type { McpToolSummary } from "../../../db/schema/mcp.schema"
import { isMcpToolId, mcpService, parseMcpToolId } from "../../mcp/mcp.service"
import { datasourceService } from "../../datasource/datasource.service"
import { createDatabaseTool } from "./database.tool"
import { createMcpTool } from "./mcp.tool"
import { TOOL_CATALOGUE, isToolId } from "./catalogue"
import type { ToolId } from "./catalogue"
import type { AgentTool } from "./types"

export type { AgentTool, ToolContext, ToolResult } from "./types"
export { TOOL_CATALOGUE, TOOL_IDS, isToolId, toolWrites } from "./catalogue"
export type { ToolId } from "./catalogue"

/**
 * The tools one run may call, built from the version it is executing.
 *
 * `knowledge_search` and `save_document` are closed over the version's own
 * knowledge bases rather than taking them as an argument, so the model can
 * neither search nor write into a base it was not given.
 */
export function toolsFor(
	ids: string[],
	knowledgeBaseIds: string[],
	citations: CitationCollector,
	memory?: { agentId: string; scope: "agent" | "user"; topK: number },
): AgentTool[] {
	const tools: AgentTool[] = []
	for (const id of ids) {
		if (id === "knowledge_search") {
			tools.push(createKnowledgeSearchTool(knowledgeBaseIds, citations))
		}
		if (id === "save_document") tools.push(createSaveDocumentTool(knowledgeBaseIds))
		if (id === "http_request") tools.push(httpRequestTool)
		if (id === "web_search") tools.push(webSearchTool)
		if (id === "api_call") tools.push(apiCallTool)
		if (id === "send_email") tools.push(sendEmailTool)
		// The attachment id is an argument here, unlike a knowledge base id,
		// because the run has no fixed list of images — but it is resolved
		// workspace-scoped, so an id from another tenant is a 404 rather than a
		// leak (`image-attachment.ts`).
		if (id === "image_ocr") tools.push(imageOcrTool)
		if (id === "image_vision") tools.push(imageVisionTool)
		// Same argument as the image tools, and the same protection: the model
		// names an attachment, and the speech service resolves it workspace-scoped
		// (`speech-transcribe.tool.ts`).
		if (id === "speech_transcribe") tools.push(speechTranscribeTool)
		if (id === "speech_synthesize") tools.push(speechSynthesizeTool)
		// Same argument again: the model names a spreadsheet, and `excel_read`
		// resolves it through `findOrFail(workspaceId, …)` (`excel.tool.ts`).
		if (id === "excel_read") tools.push(excelReadTool)
		if (id === "excel_write") tools.push(excelWriteTool)
		// The one tool here whose target is neither a knowledge base nor an
		// attachment but an arbitrary URL the model chose. Its guard is the address
		// check, and what that guard does not cover is written out in
		// `browser.tool.ts`.
		if (id === "browser_read") tools.push(browserReadTool)
		// The connected Google account is resolved from the workspace, never named
		// by the model — the same rule the knowledge bases follow.
		const google = GOOGLE_TOOLS.find((tool) => tool.name === id)
		if (google) tools.push(google)
		const app = APP_TOOLS.find((tool) => tool.name === id)
		if (app) tools.push(app)
	}

	// Closed over the agent and the scope the version was published with, for the
	// same reason `knowledge_search` is closed over its bases: the model decides
	// what to remember, never whose memory to read or write. A version with
	// memory off gets neither tool even if its list names them, so turning memory
	// off actually turns it off.
	if (memory && (ids.includes("memory_write") || ids.includes("memory_search"))) {
		const both = createMemoryTools(memory)
		for (const tool of both) {
			if (ids.includes(tool.name)) tools.push(tool)
		}
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
		// A tool that brought its own schema keeps it; everything else derives one
		// from what its arguments are validated against, so the two cannot drift.
		parameters:
			tool.jsonSchema ??
			(z.toJSONSchema(tool.parameters, {
				io: "input",
				unrepresentable: "any",
			}) as Record<string, unknown>),
	}
}

/**
 * The MCP tools one run may call, resolved from the version's tool list.
 *
 * Separate from `toolsFor` and asynchronous because discovery is a network call:
 * a third-party server has to be asked what it offers, and the cached answer has
 * to be refreshed. Keeping `toolsFor` synchronous means every built-in tool is
 * still assembled without touching anything (ADR-056).
 *
 * A tool id naming a server this workspace cannot reach is **skipped**, not
 * fatal. A version is an immutable record of what was configured; a server
 * deleted after it was published should cost that agent one tool, not every run.
 */
/**
 * The database tool, built from the queries this workspace has approved.
 *
 * Asynchronous and separate from `toolsFor` for the same reason the MCP tools
 * are: the list is a read. The tool's own description carries the catalogue, so
 * a model can only call what it has been told about — and telling it is the same
 * act as approving (ADR-064).
 */
export async function databaseToolFor(
	workspaceId: string,
	ids: string[],
): Promise<AgentTool[]> {
	if (!ids.includes("database_query")) return []

	const queries = await datasourceService.callableQueries(workspaceId)
	if (queries.length === 0) return []

	return [
		createDatabaseTool(
			queries.map((query) => ({
				name: query.name,
				description: query.description,
				parameters: query.parameters.map((parameter) => ({
					name: parameter.name,
					type: parameter.type,
				})),
			})),
		),
	]
}

export async function mcpToolsFor(
	workspaceId: string,
	ids: string[],
	signal?: AbortSignal,
): Promise<AgentTool[]> {
	const wanted = ids.filter(isMcpToolId)
	if (wanted.length === 0) return []

	const tools: AgentTool[] = []
	const listed = new Map<string, McpToolSummary[]>()

	for (const id of wanted) {
		const parsed = parseMcpToolId(id)
		if (!parsed) continue

		if (!listed.has(parsed.slug)) {
			const server = await mcpService.findForWorkspace(workspaceId, parsed.slug)
			listed.set(
				parsed.slug,
				server?.enabled ? await mcpService.toolsForRun(server, signal) : [],
			)
		}

		const summary = listed.get(parsed.slug)?.find((tool) => tool.name === parsed.tool)
		if (!summary) continue

		const built = createMcpTool(id, summary)
		if (built) tools.push(built)
	}

	return tools
}
