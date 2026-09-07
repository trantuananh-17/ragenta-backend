import { Buffer } from "node:buffer"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ProviderError } from "../clients/types"
import { createSpeechToText, createTextToSpeech } from "./openai-compatible"

/**
 * What the speech clients actually put on the wire.
 *
 * `fetch` is stubbed rather than the request builders being exported, for the
 * same reason as `src/ai/clients/multimodal.test.ts`: the request is what a
 * speaches container or a VieNeu sidecar will receive, and asserting the real
 * one is the only way to know that a server nobody here can run would accept
 * it. The multipart field names are the contract — a transcription posted with
 * `audio` instead of `file` is a 422 from every server speaking this API.
 */

interface Captured {
	url: string
	headers: Record<string, string>
	body: unknown
}

let captured: Captured | undefined

function stubFetch(respond: () => Response): void {
	captured = undefined
	vi.stubGlobal("fetch", async (url: unknown, init: unknown) => {
		const request = init as { headers?: Record<string, string>; body?: unknown } | undefined
		captured = {
			url: String(url),
			headers: request?.headers ?? {},
			body: request?.body,
		}
		return respond()
	})
}

function json(payload: unknown): () => Response {
	return () =>
		new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		})
}

function request(): Captured {
	if (!captured) throw new Error("fetch was never called")
	return captured
}

function form(): FormData {
	const body = request().body
	if (!(body instanceof FormData)) throw new Error("the request body was not multipart")
	return body
}

/** A key that is obviously a key, so a leak into an error message is unmissable. */
const API_KEY = "sk-speech-secret-0123456789"

// The trailing slash is deliberate: an operator pasting a base URL leaves one.
const stt = createSpeechToText({
	id: "speech-to-text",
	baseUrl: "https://speech.test/v1/",
	apiKey: API_KEY,
	model: "Systran/faster-whisper-large-v3",
})

const tts = createTextToSpeech({
	id: "text-to-speech",
	baseUrl: "https://voice.test/v1",
	apiKey: API_KEY,
	model: "vieneu-tts",
})

const CLIP = {
	audio: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
	mimeType: "audio/webm",
	fileName: "recording.webm",
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("speech-to-text requests", () => {
	it("posts multipart to /audio/transcriptions with the model and the file", async () => {
		stubFetch(json({ text: "xin chào" }))
		await stt.transcribe(CLIP)

		expect(request().url).toBe("https://speech.test/v1/audio/transcriptions")
		expect(form().get("model")).toBe("Systran/faster-whisper-large-v3")
		expect(form().get("response_format")).toBe("verbose_json")

		const file = form().get("file")
		expect(file).toBeInstanceOf(Blob)
		expect((file as Blob & { name?: string }).name).toBe("recording.webm")
		expect((file as Blob).type).toBe("audio/webm")
	})

	it("leaves the content type to fetch, which owns the multipart boundary", async () => {
		stubFetch(json({ text: "" }))
		await stt.transcribe(CLIP)

		expect(request().headers["content-type"]).toBeUndefined()
		expect(request().headers.authorization).toBe(`Bearer ${API_KEY}`)
	})

	it("sends language when the caller knows it", async () => {
		stubFetch(json({ text: "xin chào" }))
		await stt.transcribe({ ...CLIP, language: "vi", prompt: "Ragenta" })

		expect(form().get("language")).toBe("vi")
		expect(form().get("prompt")).toBe("Ragenta")
	})

	it("omits language entirely when it is unknown, rather than sending it empty", async () => {
		stubFetch(json({ text: "hello" }))
		await stt.transcribe(CLIP)

		expect(form().has("language")).toBe(false)
		expect(form().has("prompt")).toBe(false)
	})
})

describe("speech-to-text responses", () => {
	it("maps a verbose_json body to text, duration and segments", async () => {
		stubFetch(
			json({
				text: "xin chào các bạn",
				language: "vi",
				duration: 3.25,
				segments: [
					{ start: 0, end: 1.5, text: "xin chào" },
					{ start: 1.5, end: 3.25, text: " các bạn" },
				],
			}),
		)

		const result = await stt.transcribe(CLIP)
		expect(result.text).toBe("xin chào các bạn")
		expect(result.language).toBe("vi")
		expect(result.durationSec).toBe(3.25)
		expect(result.segments).toEqual([
			{ start: 0, end: 1.5, text: "xin chào" },
			{ start: 1.5, end: 3.25, text: " các bạn" },
		])
	})

	it("accepts a server that ignores verbose_json and answers with text alone", async () => {
		stubFetch(json({ text: "hello there" }))

		const result = await stt.transcribe({ ...CLIP, language: "en" })
		expect(result.text).toBe("hello there")
		expect(result.segments).toEqual([])
		expect(result.durationSec).toBeUndefined()
		// The requested language stands in for one the server did not report.
		expect(result.language).toBe("en")
	})

	it("refuses a body with no text at all", async () => {
		stubFetch(json({ duration: 1 }))
		await expect(stt.transcribe(CLIP)).rejects.toBeInstanceOf(ProviderError)
	})
})

describe("text-to-speech", () => {
	it("posts the OpenAI speech body and returns the bytes under the requested type", async () => {
		const bytes = Buffer.from([0xff, 0xfb, 0x90, 0x00])
		stubFetch(() => new Response(bytes, { status: 200 }))

		const result = await tts.synthesize({
			text: "xin chào",
			voice: "vieneu-female-north",
			format: "mp3",
			speed: 1.1,
		})

		expect(request().url).toBe("https://voice.test/v1/audio/speech")
		expect(JSON.parse(String(request().body)) as Record<string, unknown>).toEqual({
			model: "vieneu-tts",
			input: "xin chào",
			voice: "vieneu-female-north",
			response_format: "mp3",
			speed: 1.1,
		})
		expect(result.audio).toBeInstanceOf(Buffer)
		expect([...result.audio]).toEqual([...bytes])
		expect(result.mimeType).toBe("audio/mpeg")
		expect(result.sampleRate).toBeUndefined()
	})

	it("states the sample rate for pcm, which carries no header to say it", async () => {
		stubFetch(() => new Response(Buffer.from([0, 0]), { status: 200 }))

		const result = await tts.synthesize({ text: "hi", voice: "alloy", format: "pcm" })
		expect(result.mimeType).toBe("audio/pcm")
		expect(result.sampleRate).toBe(24_000)
	})
})

describe("upstream failures", () => {
	it("raises a ProviderError without the key, even when the server echoes it back", async () => {
		stubFetch(
			() =>
				new Response(`{"error":"invalid key ${API_KEY} for Bearer ${API_KEY}"}`, {
					status: 401,
					statusText: "Unauthorized",
				}),
		)

		const error = await stt.transcribe(CLIP).catch((cause: unknown) => cause)
		expect(error).toBeInstanceOf(ProviderError)
		const message = (error as ProviderError).message
		expect(message).toContain("401")
		expect(message).not.toContain(API_KEY)
		expect((error as ProviderError).status).toBe(502)
	})

	it("raises a ProviderError for synthesis too", async () => {
		stubFetch(() => new Response("model not found", { status: 404, statusText: "Not Found" }))

		await expect(
			tts.synthesize({ text: "hi", voice: "whoever", format: "wav" }),
		).rejects.toBeInstanceOf(ProviderError)
	})
})
