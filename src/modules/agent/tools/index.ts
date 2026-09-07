import { z } from "zod"

import type { ToolDefinition } from "../../../ai/clients"
import type { CitationCollector } from "../citations"
import { apiCallTool } from "./api-call.tool"
import { httpRequestTool } from "./http-request.tool"
import { imageOcrTool } from "./image-ocr.tool"
import { imageVisionTool } from "./image-vision.tool"
import { createKnowledgeSearchTool } from "./knowledge-search.tool"
import { createSaveDocumentTool } from "./save-document.tool"
import { sendEmailTool } from "./send-email.tool"
import { speechSynthesizeTool } from "./speech-synthesize.tool"
import { speechTranscribeTool } from "./speech-transcribe.tool"
import { webSearchTool } from "./web-search.tool"
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
