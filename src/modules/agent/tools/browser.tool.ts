import { z } from "zod"

import { env } from "../../../config/env"
import { isAppError } from "../../../shared/errors"
import {
	browserReadParameters,
	checkBrowsableUrl,
	renderBrowsedElements,
	renderBrowsedPage,
} from "./browser-content"
import type { BrowsedElements } from "./browser-content"
import { htmlToText, readHtmlTitle } from "./html-text"
import { assertHostAllowed, readCappedText } from "./safe-fetch"
import type { AgentTool, ToolContext, ToolResult } from "./types"

/**
 * Read a page the way a person's browser would see it.
 *
 * Some pages are a script that fetches its own content, and `http_request` gets
 * an empty shell from them. This is the fallback for those: a real browser
 * renders the page and hands back what it produced.
 *
 * **It runs somewhere else, and that is the design.** Ragenta deploys as Docker
 * Compose on small VMs (ADR-008); putting Chromium in the API image would
 * multiply its size and its resident memory for a tool that is a last resort
 * after an API. So this file defines what a browser has to be able to do and
 * talks to whatever provides it over plain HTTP — no driver library, no bundled
 * engine, and a deployment that has not configured one simply refuses.
 *
 * ## The SSRF limitation, stated plainly
 *
 * The URL comes from the model, which may have read it out of a document
 * somebody uploaded. Every URL is checked here first: protocol, literal address,
 * and every address the hostname resolves to, using the same ranges `safeFetch`
 * uses (`browser-content.ts`, `safe-fetch.ts`).
 *
 * **That check does not close the hole, and nothing in this file claims it
 * does.** We do not open the connection — the browser service does, and it
 * resolves the hostname itself, from its own container, at a later moment than
 * our lookup. A name that answers publicly for our resolver and privately for
 * its own, or that changes its answer between the two calls, reaches whatever
 * the browser service can reach. Our pre-check raises the cost of that; it is
 * not a boundary.
 *
 * The boundary that actually holds is the browser service's own network: run it
 * where it cannot see the database, Redis, the object store or a cloud metadata
 * endpoint, and an SSRF through it reaches nothing worth reaching. That is a
 * deployment property, so it is written down in `.env.example` beside the
 * variables rather than only here.
 *
 * `writes: false`: this navigates and reads. Clicking, typing and submitting are
 * a different tool with a different risk — a model persuaded by a page into
 * pressing "confirm" has done something that cannot be undone — and they belong
 * behind their own ADR and their own approval gate, not behind an extra enum
 * member on this one.
 */

/** A rendered page is slower than a fetch and much larger. */
const BROWSER_TIMEOUT_MS = 30_000
const MAX_PAGE_BYTES = 2 * 1024 * 1024

export interface BrowserPageContent {
	title: string | null
	text: string
}

/**
 * What this tool needs a browser to be able to do.
 *
 * Small on purpose: navigate, and extract. Anything a particular service also
 * offers — sessions, screenshots, PDFs — is not in here, because a second
 * implementation would then have to grow it too, and none of it is what an agent
 * reading a page needs.
 */
export interface BrowserProvider {
	/** For the run timeline, so a bad render is traceable to what produced it. */
	readonly id: string
	/** Load the page and return its readable text. */
	readPage(url: string, signal?: AbortSignal): Promise<BrowserPageContent>
	/** Load the page and return the text each selector matched. */
	readElements(
		url: string,
		selectors: string[],
		signal?: AbortSignal,
	): Promise<{ title: string | null; elements: BrowsedElements[] }>
}

/** browserless answers `/scrape` with one entry per selector. Validated, not trusted. */
const scrapeResponse = z.object({
	data: z
		.array(
			z.object({
				selector: z.string(),
				results: z.array(z.object({ text: z.string().optional() })).optional(),
			}),
		)
		.optional(),
})

/**
 * The browserless REST shape: JSON in, JSON or HTML out, no client library.
 *
 * Chosen over a driver protocol because it needs no dependency at all — a
 * `fetch` and two endpoints — and because anything else that speaks it is a
 * drop-in replacement.
 */
function browserlessProvider(config: { baseUrl: string; token?: string }): BrowserProvider {
	async function call(path: string, payload: unknown, signal?: AbortSignal): Promise<Response> {
		const timeout = AbortSignal.timeout(BROWSER_TIMEOUT_MS)
		const response = await fetch(endpoint(config, path), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		})

		if (!response.ok) {
			// The service's own body may hold the page's URL and the token is in the
			// endpoint, so neither goes into the message the model reads.
			throw new BrowserServiceError(
				`The browser service could not load that page (HTTP ${response.status}).`,
			)
		}
		return response
	}

	return {
		id: "browserless",

		async readPage(url, signal) {
			const response = await call("content", { url }, signal)
			const { body } = await readCappedText(response, MAX_PAGE_BYTES)
			return { title: readHtmlTitle(body), text: htmlToText(body) }
		},

		async readElements(url, selectors, signal) {
			const response = await call(
				"scrape",
				{ url, elements: selectors.map((selector) => ({ selector })) },
				signal,
			)
			const { body } = await readCappedText(response, MAX_PAGE_BYTES)

			let parsed: z.infer<typeof scrapeResponse>
			try {
				parsed = scrapeResponse.parse(JSON.parse(body))
			} catch {
				throw new BrowserServiceError("The browser service returned something unreadable.")
			}

			const bySelector = new Map(
				(parsed.data ?? []).map((entry) => [
					entry.selector,
					(entry.results ?? []).map((result) => result.text ?? "").filter(Boolean),
				]),
			)

			return {
				// `/scrape` returns matches, not the document, so there is no title to
				// read out of it. Null rather than a second page load for a heading.
				title: null,
				// Keyed back to what was asked for, so a selector the service dropped
				// reads as "nothing matched" instead of silently disappearing.
				elements: selectors.map((selector) => ({
					selector,
					matches: bySelector.get(selector) ?? [],
				})),
			}
		},
	}
}

/**
 * browserless reads its token from the query string. Nothing here logs the
 * endpoint for that reason — the run timeline gets the page URL the model asked
 * for, never the URL we called (`.claude/rules/security.md`).
 */
function endpoint(config: { baseUrl: string; token?: string }, path: string): URL {
	const base = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`
	const url = new URL(path, base)
	if (config.token) url.searchParams.set("token", config.token)
	return url
}

class BrowserServiceError extends Error {}

export const browserReadTool: AgentTool = {
	name: "browser_read",
	description:
		"Open a page in a real browser and read what it renders. Use it when a plain fetch returns an empty shell because the page builds itself with JavaScript. Give it a URL, and CSS selectors if you only want part of the page. It reads pages; it cannot click, type or submit anything.",
	parameters: browserReadParameters,
	writes: false,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = browserReadParameters.parse(args)

		const config = env.browser
		if (!config) {
			return {
				ok: false,
				content:
					"This deployment has no browser service configured, so pages cannot be opened in a browser. A plain fetch may still work.",
				metadata: { url: input.url, refused: "browser_not_configured" },
			}
		}

		const checked = checkBrowsableUrl(input.url)
		if (!checked.ok) {
			return {
				ok: false,
				content: checked.reason,
				metadata: { url: input.url, refused: "url_not_allowed" },
			}
		}

		try {
			// Resolve and re-check, because the literal-address check above says
			// nothing about where a hostname points. See this file's header for what
			// this does and does not buy.
			await assertHostAllowed(checked.url.hostname)

			const provider = browserlessProvider(config)
			const url = checked.url.toString()

			if (input.selectors) {
				const { title, elements } = await provider.readElements(
					url,
					input.selectors,
					context.signal,
				)
				return {
					ok: true,
					content: renderBrowsedElements({ url, title }, elements),
					metadata: {
						url,
						provider: provider.id,
						selectors: input.selectors,
						matches: elements.map((element) => ({
							selector: element.selector,
							count: element.matches.length,
						})),
					},
				}
			}

			const page = await provider.readPage(url, context.signal)
			return {
				ok: true,
				content: renderBrowsedPage({ url, title: page.title, text: page.text }),
				metadata: {
					url,
					provider: provider.id,
					title: page.title,
					characters: page.text.length,
				},
			}
		} catch (error) {
			// A blocked address, a page that would not load, a service that timed out.
			// A refusal rather than a throw, so a run that has another way to answer
			// still gets to take it (`types.ts`).
			return {
				ok: false,
				content:
					error instanceof BrowserServiceError || isAppError(error)
						? error.message
						: "That page could not be opened.",
				metadata: {
					url: input.url,
					refused: isAppError(error) ? error.code : "browser_failed",
				},
			}
		}
	},
}
