import { z } from "zod"

import { isAppError } from "../../../shared/errors"
import { safeFetch } from "./safe-fetch"
import type { AgentTool, ToolContext, ToolResult } from "./types"

const parameters = z.object({
	url: z.string().url().max(2_000).describe("The absolute http or https URL to fetch."),
	method: z.enum(["GET", "POST"]).optional().describe("Defaults to GET."),
	body: z.string().max(4_000).optional().describe("Request body, for POST."),
})

/** What the model gets back, before the whole page would drown its context. */
const MAX_CONTENT = 8_000

/**
 * Fetch a URL.
 *
 * Every check that makes this safe lives in `safeFetch`, deliberately: this file
 * is the tool's contract with the model, that one is the security boundary, and
 * mixing them is how a later edit quietly removes a check.
 *
 * HTML is reduced to text before the model sees it. A page's markup is most of
 * its bytes and none of its meaning, and a run that spent its context window on
 * `<div class="...">` would be paying for nothing.
 */
export const httpRequestTool: AgentTool = {
	name: "http_request",
	description:
		"Fetch a public web page or HTTP API and return its content as text. Only http and https URLs on the public internet can be reached. Large responses are truncated.",
	parameters,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = parameters.parse(args)

		try {
			const response = await safeFetch(
				input.url,
				{ method: input.method ?? "GET", body: input.body },
				context.signal,
			)

			const text = response.contentType.includes("html")
				? stripHtml(response.body)
				: response.body

			const clipped = text.slice(0, MAX_CONTENT)
			const truncated = response.truncated || text.length > MAX_CONTENT

			return {
				ok: response.status >= 200 && response.status < 300,
				content: [
					`HTTP ${response.status} from ${response.finalUrl}`,
					clipped || "(the response had no body)",
					truncated ? "\n[content truncated]" : "",
				]
					.filter(Boolean)
					.join("\n\n"),
				metadata: {
					url: input.url,
					finalUrl: response.finalUrl,
					status: response.status,
					truncated,
				},
			}
		} catch (error) {
			// A refused or failed fetch is reported *to the model*, not thrown: it
			// can try a different URL, and ending the whole run over one bad link
			// would throw away everything already done.
			return {
				ok: false,
				content: isAppError(error)
					? error.message
					: "That URL could not be fetched.",
				metadata: { url: input.url },
			}
		}
	},
}

/** Enough to turn a page into readable text. Not a parser, and not trying to be. */
function stripHtml(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim()
}
