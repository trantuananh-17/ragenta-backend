import { z } from "zod"

import type { CitationCollector } from "../citations"
import { knowledgeService } from "../../knowledge/knowledge.service"
import { retrievalService } from "../../retrieval/retrieval.service"
import type { SearchMode } from "../../retrieval/retrieval.service"
import type { AgentTool, ToolContext, ToolResult } from "./types"

const parameters = z.object({
	query: z
		.string()
		.trim()
		.min(1)
		.max(1_000)
		.describe("What to search for, as a standalone question or phrase."),
	topK: z
		.number()
		.int()
		.min(1)
		.max(20)
		.optional()
		.describe("How many passages to return. Defaults to the knowledge base's own setting."),
})

/**
 * Search the agent's knowledge bases.
 *
 * The bases are **not** an argument. They come from the version the run is
 * executing, so a model cannot widen its own reach by naming a base it was never
 * given — the same rule that governs every other id in this codebase
 * (`.claude/rules/security.md`).
 */
export function createKnowledgeSearchTool(
	knowledgeBaseIds: string[],
	citations: CitationCollector,
): AgentTool {
	return {
		name: "knowledge_search",
		description:
			"Search this agent's knowledge bases for passages relevant to a query. Returns numbered passages with their source. Use it before answering anything the documents might cover, and search again with different wording if the first result is thin.",
		parameters,

		async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
			const input = parameters.parse(args)

			if (knowledgeBaseIds.length === 0) {
				return {
					ok: false,
					content: "This agent has no knowledge bases attached, so there is nothing to search.",
				}
			}

			// A base deleted since the version was published is skipped rather than
			// fatal: the version is an immutable record and cannot be corrected.
			const live: string[] = []
			for (const baseId of knowledgeBaseIds) {
				const exists = await knowledgeService
					.getBase(context.workspaceId, baseId)
					.then(() => true)
					.catch(() => false)
				if (exists) live.push(baseId)
			}

			if (live.length === 0) {
				return {
					ok: false,
					content: "Every knowledge base this agent was configured with has been deleted.",
				}
			}

			const outcome = await retrievalService.retrieve({
				workspaceId: context.workspaceId,
				knowledgeBaseIds: live,
				question: input.query,
				topK: input.topK,
			})

			if (outcome.chunks.length === 0) {
				return {
					ok: true,
					content: `No passage matched "${input.query}".`,
					metadata: { query: input.query, results: 0 },
				}
			}

			// Numbered by the run, not by this call: two searches each numbering
			// from 1 would make [[1]] ambiguous and the answer's citations wrong.
			const numbered = citations.add(outcome.chunks)
			const rendered = outcome.chunks
				.map((chunk, position) => {
					const citation = numbered[position]
					const page = chunk.fromPage === null ? "" : ` (page ${chunk.fromPage})`
					return `[[${citation?.index ?? position + 1}]] source: ${chunk.documentName}${page}\n${chunk.content}`
				})
				.join("\n\n---\n\n")

			return {
				ok: true,
				content: rendered,
				metadata: {
					query: input.query,
					results: outcome.chunks.length,
					documents: [...new Set(outcome.chunks.map((chunk) => chunk.documentName))],
				},
				// The reranker is a provider call like any other and the run pays for
				// it whether or not the answer uses what it ranked.
				usage: outcome.rerankUsage
					? {
							provider: outcome.rerankUsage.provider,
							model: outcome.rerankUsage.model,
							inputTokens: outcome.rerankUsage.tokens,
							outputTokens: 0,
							operation: "rerank",
						}
					: undefined,
			}
		},
	}
}
