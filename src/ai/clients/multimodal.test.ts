import { afterEach, describe, expect, it, vi } from "vitest"

import { anthropicClient } from "./anthropic"
import { googleClient } from "./google"
import { openaiClient } from "./openai"
import type { ChatMessage } from "./types"

/**
 * What the three adapters actually put on the wire when a message carries an
 * image.
 *
 * `fetch` is stubbed rather than the mapping functions being exported for the
 * test: the mapping is private on purpose, and asserting the request body of
 * the real `chat()` proves the thing that ships rather than a function that
 * happens to sit next to it.
 *
 * The uncaptioned case is the one that matters most. Attaching an image and
 * pressing send without typing anything is the ordinary way to use this
 * feature, and Anthropic rejects a text block that is empty — so a blank text
 * part is not a cosmetic flaw, it is a 400 on the most common path.
 */

type WirePart = Record<string, unknown>
interface Captured {
	url: string
	body: Record<string, unknown>
}

let captured: Captured | undefined

function stubFetch(): void {
	captured = undefined
	vi.stubGlobal("fetch", async (url: unknown, init: unknown) => {
		const request = init as { body?: unknown } | undefined
		captured = {
			url: String(url),
			body: JSON.parse(String(request?.body ?? "{}")) as Record<string, unknown>,
		}
		return new Response("{}", {
			status: 200,
			headers: { "content-type": "application/json" },
		})
	})
}

function body(): Record<string, unknown> {
	if (!captured) throw new Error("fetch was never called")
	return captured.body
}

const PIXEL = "iVBORw0KGgoAAAANSUhEUg=="

function withImage(content: string): ChatMessage[] {
	return [{ role: "user", content, images: [{ mediaType: "image/png", dataBase64: PIXEL }] }]
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("openai image mapping", () => {
	it("sends a text part and a data-URL image part", async () => {
		stubFetch()
		await openaiClient.chat?.({ apiKey: "k" }, { model: "gpt-4o", messages: withImage("What is this?") })

		const messages = body().messages as Array<{ role: string; content: WirePart[] }>
		expect(messages[0]?.role).toBe("user")
		expect(messages[0]?.content).toEqual([
			{ type: "text", text: "What is this?" },
			{ type: "image_url", image_url: { url: `data:image/png;base64,${PIXEL}` } },
		])
	})

	it("omits the text part when the image has no caption", async () => {
		stubFetch()
		await openaiClient.chat?.({ apiKey: "k" }, { model: "gpt-4o", messages: withImage("") })

		const messages = body().messages as Array<{ role: string; content: WirePart[] }>
		expect(messages[0]?.content).toHaveLength(1)
		expect(messages[0]?.content[0]).toHaveProperty("type", "image_url")
	})

	it("leaves a text-only message as a plain string", async () => {
		stubFetch()
		await openaiClient.chat?.(
			{ apiKey: "k" },
			{ model: "gpt-4o", messages: [{ role: "user", content: "hello" }] },
		)

		const messages = body().messages as Array<{ role: string; content: unknown }>
		expect(messages[0]?.content).toBe("hello")
	})
})

describe("anthropic image mapping", () => {
	it("sends a base64 source block beside the text block", async () => {
		stubFetch()
		await anthropicClient.chat?.(
			{ apiKey: "k" },
			{ model: "claude-sonnet-5", messages: withImage("Read this") },
		)

		const messages = body().messages as Array<{ role: string; content: WirePart[] }>
		expect(messages[0]?.content).toEqual([
			{ type: "text", text: "Read this" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL } },
		])
	})

	it("omits the empty text block, which the API would reject", async () => {
		stubFetch()
		await anthropicClient.chat?.(
			{ apiKey: "k" },
			{ model: "claude-sonnet-5", messages: withImage("") },
		)

		const messages = body().messages as Array<{ role: string; content: WirePart[] }>
		expect(messages[0]?.content).toHaveLength(1)
		expect(messages[0]?.content[0]).toHaveProperty("type", "image")
	})
})

describe("google image mapping", () => {
	it("sends inlineData in the model's own camelCase spelling", async () => {
		stubFetch()
		await googleClient.chat?.(
			{ apiKey: "k" },
			{ model: "gemini-2.5-flash", messages: withImage("Describe it") },
		)

		const contents = body().contents as Array<{ role: string; parts: WirePart[] }>
		expect(contents[0]?.parts).toEqual([
			{ text: "Describe it" },
			{ inlineData: { mimeType: "image/png", data: PIXEL } },
		])
	})

	it("omits the empty text part when the image has no caption", async () => {
		stubFetch()
		await googleClient.chat?.(
			{ apiKey: "k" },
			{ model: "gemini-2.5-flash", messages: withImage("") },
		)

		const contents = body().contents as Array<{ role: string; parts: WirePart[] }>
		expect(contents[0]?.parts).toHaveLength(1)
		expect(contents[0]?.parts[0]).toHaveProperty("inlineData")
	})
})
