import { Buffer } from "node:buffer"

import { z } from "zod"

import { isAppError } from "../../../shared/errors"
import { knowledgeService } from "../../knowledge/knowledge.service"
import type { AgentTool, ToolContext, ToolResult } from "./types"

const parameters = z.object({
	knowledgeBaseId: z
		.string()
		.min(1)
		.describe("Which of this agent's knowledge bases to write into."),
	title: z
		.string()
		.trim()
		.min(1)
		.max(150)
		.describe("A filename for the document, without an extension."),
	content: z.string().trim().min(1).max(100_000).describe("The document body, as Markdown."),
})

/**
 * Write what the agent produced back into a knowledge base.
 *
 * This is the tool that makes an agent's work compound rather than evaporate: a
 * summary it wrote today is a document the next run can search. Ingestion is the
 * ordinary path — chunked, embedded and indexed by the worker — so it behaves
 * exactly like a file somebody uploaded, and nothing special has to be true of it.
 *
 * The bases it may write to come from the version, not from the model. It is
 * given the ids it already searches, so an agent cannot be talked into writing
 * into a knowledge base it was never pointed at.
 */
export function createSaveDocumentTool(knowledgeBaseIds: string[]): AgentTool {
	return {
		name: "save_document",
		description:
			"Save text into one of this agent's knowledge bases as a new document. It is indexed like any uploaded file, so later runs can search it. Use it for a report, a summary or notes worth keeping.",
		parameters,
		writes: true,

		async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
			const input = parameters.parse(args)

			if (!knowledgeBaseIds.includes(input.knowledgeBaseId)) {
				return {
					ok: false,
					content: `This agent may only write into: ${knowledgeBaseIds.join(", ") || "(none)"}.`,
					metadata: { refused: "base_not_allowed" },
				}
			}

			try {
				// A generated filename, never one the model chose, for the same reason
				// an upload never trusts the browser's: the name reaches storage.
				const name = `${input.title.replace(/[^\w\s-]/g, "").trim() || "agent-note"}.md`
				const document = await knowledgeService.uploadDocument(
					context.workspaceId,
					input.knowledgeBaseId,
					{
						name,
						mimeType: "text/markdown",
						bytes: Buffer.from(input.content, "utf8"),
					},
					{},
					context.userId ?? "",
				)

				return {
					ok: true,
					content: `Saved "${name}". It is being indexed and will be searchable shortly.`,
					metadata: {
						documentId: (document as { id?: string })?.id ?? null,
						knowledgeBaseId: input.knowledgeBaseId,
						characters: input.content.length,
					},
				}
			} catch (error) {
				return {
					ok: false,
					content: isAppError(error)
						? error.message
						: "That document could not be saved.",
					metadata: { error: "save_failed" },
				}
			}
		},
	}
}
