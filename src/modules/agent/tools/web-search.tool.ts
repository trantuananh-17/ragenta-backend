import { z } from "zod"

import { isAppError } from "../../../shared/errors"
import { markUsed, requireIntegration } from "./integrations"
import { safeFetch } from "./safe-fetch"
import type { AgentTool, ToolContext, ToolResult } from "./types"

const parameters = z.object({
	query: z.string().trim().min(1).max(400).describe("What to search the web for."),
	results: z.number().int().min(1).max(10).default(5).describe("How many results to return."),
})

interface TavilyResponse {
	answer?: string
	results?: { title?: string; url?: string; content?: string }[]
}

/**
 * Search the open web.
 *
 * Tavily rather than a general engine because it answers with extracted text
 * rather than a page of links: an agent that had to fetch and strip five HTML
 * pages to answer one question would spend most of a context window on markup.
 *
 * A search result is **untrusted input**, and more so than a document the
 * customer uploaded — nobody in the workspace chose it. It goes into the model
 * as data, and the system prompt for a tool-using agent says so explicitly.
 */
export const webSearchTool: AgentTool = {
	name: "web_search",
	description:
		"Search the public web and get back extracted text from the best results, with their URLs. Use it for anything the knowledge bases would not cover — current events, public documentation, a company you were asked about.",
	parameters,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = parameters.parse(args)

		try {
			const { row, secret } = await requireIntegration("tavily", "web_search")
			if (!secret) {
				return {
					ok: false,
					content: "The web search connection has no API key configured.",
					metadata: { refused: "no_key" },
				}
			}

			const response = await safeFetch(
				`${(row.baseUrl ?? "https://api.tavily.com").replace(/\/+$/, "")}/search`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						api_key: secret,
						query: input.query,
						max_results: input.results,
						include_answer: true,
					}),
				},
				context.signal,
			)
			await markUsed(row.id)

			if (response.status < 200 || response.status >= 300) {
				return {
					ok: false,
					content: `The search service answered ${response.status}.`,
					metadata: { status: response.status },
				}
			}

			let body: TavilyResponse
			try {
				body = JSON.parse(response.body) as TavilyResponse
			} catch {
				return {
					ok: false,
					content: "The search service returned something that was not JSON.",
					metadata: { error: "bad_payload" },
				}
			}

			const results = body.results ?? []
			if (results.length === 0) {
				return {
					ok: true,
					content: `Nothing was found for "${input.query}".`,
					metadata: { query: input.query, results: 0 },
				}
			}

			const rendered = results
				.map(
					(result, index) =>
						`(${index + 1}) ${result.title ?? "Untitled"}\n${result.url ?? ""}\n${(result.content ?? "").slice(0, 1_200)}`,
				)
				.join("\n\n---\n\n")

			return {
				ok: true,
				content: body.answer
					? `Summary: ${body.answer}\n\n---\n\n${rendered}`
					: rendered,
				metadata: {
					query: input.query,
					results: results.length,
					urls: results.map((result) => result.url).filter(Boolean),
				},
			}
		} catch (error) {
			return {
				ok: false,
				content: isAppError(error) ? error.message : "The search could not be run.",
				metadata: { query: input.query, error: "search_failed" },
			}
		}
	},
}
