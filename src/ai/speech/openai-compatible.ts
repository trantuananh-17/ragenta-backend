import { Buffer } from "node:buffer"

import { ProviderError, readError } from "../clients/types"
import type {
	SpeechAudioFormat,
	SpeechResult,
	SpeechToTextProvider,
	SynthesizeInput,
	TextToSpeechProvider,
	TranscribeInput,
	TranscriptResult,
} from "./types"

/**
 * The OpenAI audio API: `POST /audio/transcriptions` and `POST /audio/speech`.
 *
 * One implementation reaches both the hosted service and the self-hosted ones,
 * because the self-hosted ones were written to this contract. speaches — the
 * renamed faster-whisper-server, and the server faster-whisper's own README
 * points at, since faster-whisper ships none itself — speaks the transcription
 * route verbatim; only the base URL, the key and the model name differ. The
 * Vietnamese TTS path is the other half of the same bet: VieNeu-TTS has no
 * `/v1/` routes at all, so a sidecar will publish this shape in front of it and
 * plug in here with no code change (ADR-038).
 *
 * Written on fetch rather than the SDK for the same reason as
 * `src/ai/clients/openai.ts`: two endpoints in total, against a dependency
 * whose upgrades would have to be managed for them.
 */

export interface SpeechEndpoint {
	/** Names the provider in errors and logs — "openai", "speaches", "vieneu". */
	id: string
	baseUrl: string
	apiKey: string
	model: string
}

interface TranscriptionResponse {
	text?: string
	language?: string
	duration?: number
	segments?: { start?: number; end?: number; text?: string }[]
}

const CONTENT_TYPES: Record<SpeechAudioFormat, string> = {
	mp3: "audio/mpeg",
	opus: "audio/opus",
	aac: "audio/aac",
	flac: "audio/flac",
	wav: "audio/wav",
	pcm: "audio/pcm",
}

/**
 * What `pcm` means on this wire: 24 kHz, 16-bit signed, mono, little-endian.
 * The bytes carry no header saying so, so a server promising this API shape is
 * promising this rate — a sidecar that resamples has to resample to it.
 */
const PCM_SAMPLE_RATE = 24_000

function trimBase(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "")
}

export function createSpeechToText(endpoint: SpeechEndpoint): SpeechToTextProvider {
	return {
		id: endpoint.id,

		async transcribe(input: TranscribeInput, signal?: AbortSignal): Promise<TranscriptResult> {
			const form = new FormData()
			// Copied into a plain view because a Buffer may be backed by Node's shared
			// allocation pool, which is not a blob part.
			const bytes = new Uint8Array(input.audio)
			form.append("file", new Blob([bytes], { type: input.mimeType }), input.fileName)
			form.append("model", endpoint.model)
			// Asked for so segments and duration come back. A server that only
			// implements plain `json` ignores this and answers `{ text }`, which the
			// mapping below treats as a valid answer rather than a broken one.
			form.append("response_format", "verbose_json")
			// Omitted rather than sent empty: an empty `language` is a value the
			// server has to interpret, and some read it as a language code that does
			// not exist instead of as "detect it".
			if (input.language) form.append("language", input.language)
			if (input.prompt) form.append("prompt", input.prompt)

			const response = await fetch(`${trimBase(endpoint.baseUrl)}/audio/transcriptions`, {
				method: "POST",
				// No content-type: fetch sets it, with the multipart boundary that
				// only it knows. Setting one by hand produces a body no server can parse.
				headers: { authorization: `Bearer ${endpoint.apiKey}` },
				signal,
				body: form,
			})
			if (!response.ok) throw await readError(endpoint.id, response)

			const body = (await response.json()) as TranscriptionResponse
			if (typeof body.text !== "string") {
				throw new ProviderError(endpoint.id, "The transcription response carried no text.")
			}

			return {
				text: body.text,
				language: body.language ?? input.language,
				durationSec: body.duration,
				segments: (body.segments ?? [])
					.filter((segment) => typeof segment.text === "string")
					.map((segment) => ({
						start: segment.start ?? 0,
						end: segment.end ?? 0,
						text: segment.text ?? "",
					})),
			}
		},
	}
}

export function createTextToSpeech(endpoint: SpeechEndpoint): TextToSpeechProvider {
	return {
		id: endpoint.id,

		async synthesize(input: SynthesizeInput, signal?: AbortSignal): Promise<SpeechResult> {
			const response = await fetch(`${trimBase(endpoint.baseUrl)}/audio/speech`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${endpoint.apiKey}`,
				},
				signal,
				body: JSON.stringify({
					model: endpoint.model,
					input: input.text,
					voice: input.voice,
					response_format: input.format,
					speed: input.speed,
				}),
			})
			if (!response.ok) throw await readError(endpoint.id, response)

			// The requested format decides the type, not the response header: a
			// self-hosted shim commonly returns `application/octet-stream`, and the
			// bytes still have to be served to a browser under a type it will play.
			return {
				audio: Buffer.from(await response.arrayBuffer()),
				mimeType: CONTENT_TYPES[input.format],
				sampleRate: input.format === "pcm" ? PCM_SAMPLE_RATE : undefined,
			}
		},
	}
}
