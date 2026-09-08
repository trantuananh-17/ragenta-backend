import { z } from "zod"

import type { ToolDefinition } from "../../../ai/clients"
import type { CitationCollector } from "../citations"
import { apiCallTool } from "./api-call.tool"
import { browserReadTool } from "./browser.tool"
import { excelReadTool, excelWriteTool } from "./excel.tool"
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
import { createMcpTool } from "./mcp.tool"
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
export const TOOL_IDS = [
	"knowledge_search",
	"web_search",
	"http_request",
	"api_call",
	"send_email",
	"save_document",
	"image_ocr",
	"image_vision",
	"speech_transcribe",
	"speech_synthesize",
	"excel_read",
	"excel_write",
	"browser_read",
	"memory_write",
	"memory_search",
] as const
export type ToolId = (typeof TOOL_IDS)[number]

export function isToolId(value: string): value is ToolId {
	return (TOOL_IDS as readonly string[]).includes(value)
}

/**
 * What a version's tool list means, for the screen that offers it.
 *
 * `writes` and `requires` are here rather than only in the code because they are
 * what someone choosing tools actually needs to know: whether this will change
 * something out in the world, and whether it will work at all on this
 * deployment.
 */
export const TOOL_CATALOGUE: Record<
	ToolId,
	{
		title: string
		description: string
		writes: boolean
		/** An integration id that must exist and be enabled, or null. */
		requires: string | null
	}
> = {
	knowledge_search: {
		title: "Knowledge search",
		description:
			"Search the agent's own knowledge bases. The agent chooses when and what to search, and may search several times.",
		writes: false,
		requires: null,
	},
	web_search: {
		title: "Web search",
		description:
			"Search the public web and read the extracted text of the best results.",
		writes: false,
		requires: "tavily",
	},
	http_request: {
		title: "Fetch a URL",
		description:
			"Read a public web page or HTTP API. Private and internal addresses are blocked, and responses are capped.",
		writes: false,
		requires: null,
	},
	api_call: {
		title: "Call a connected system",
		description:
			"Call an external system through a connection an administrator configured. Each connection limits the methods and paths it allows.",
		writes: true,
		requires: null,
	},
	send_email: {
		title: "Send an email",
		description:
			"Send a plain-text email. Only addresses on the deployment's allowlist can be written to.",
		writes: true,
		requires: "email",
	},
	save_document: {
		title: "Save a document",
		description:
			"Write text back into one of the agent's knowledge bases, so later runs can search it.",
		writes: true,
		requires: null,
	},
	image_ocr: {
		title: "Read a document image",
		description:
			"Extract the text, tables and labelled values from an image attachment — a scan, a receipt, a form. Needs a vision-capable model, and re-uses an extraction the image already has.",
		writes: false,
		requires: null,
	},
	image_vision: {
		title: "Look at an image",
		description:
			"Answer a question about what an image attachment shows. Needs a vision-capable model configured for the workspace.",
		writes: false,
		requires: null,
	},
	speech_transcribe: {
		title: "Transcribe a recording",
		description:
			"Turn an audio attachment into text — a voice note, a recorded call, a meeting clip. Needs speech-to-text configured for the deployment, and re-uses a transcript the recording already has.",
		writes: false,
		requires: null,
	},
	speech_synthesize: {
		title: "Speak text aloud",
		description:
			"Generate speech from text and save it as a new audio attachment, returning its id. Needs text-to-speech configured for the deployment.",
		writes: false,
		requires: null,
	},
	excel_read: {
		title: "Read a spreadsheet",
		description:
			"Read an .xlsx attachment as rows the agent can quote and reason over. Long sheets are truncated, and the agent is told when they were.",
		writes: false,
		requires: null,
	},
	excel_write: {
		title: "Create a spreadsheet",
		description:
			"Build an .xlsx file from rows the agent produces and save it as a new file attachment, returning its id.",
		writes: false,
		requires: null,
	},
	browser_read: {
		title: "Open a page in a browser",
		description:
			"Render a page in a real browser and read it, for sites a plain fetch returns empty. Reading only — it cannot click or type. Needs a browser service configured for the deployment.",
		writes: false,
		requires: null,
	},
	memory_write: {
		title: "Remember something",
		description:
			"Keep one fact for future conversations. Only available on a version with memory turned on, and what it writes is only ever read back by this agent.",
		// It writes nothing outside Ragenta, but it does change what the agent will
		// say tomorrow — which is why it appears on the tool list rather than being
		// switched on invisibly with memory itself.
		writes: false,
		requires: null,
	},
	memory_search: {
		title: "Search what you remember",
		description:
			"Look through this agent's own memories. The most relevant are already in context at the start of a run; this is for something older or more specific.",
		writes: false,
		requires: null,
	},
}

/** Whether a tool changes something outside Ragenta. */
export function toolWrites(id: string): boolean {
	return isToolId(id) ? TOOL_CATALOGUE[id].writes : false
}

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
