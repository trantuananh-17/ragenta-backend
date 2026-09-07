import { z } from "zod"

/**
 * What an operator sets for one half of speech.
 *
 * Both halves speak the OpenAI audio API, so one shape configures either an
 * OpenAI-compatible gateway (OpenRouter, which serves `/audio/transcriptions`
 * and `/audio/speech` under one key) or a self-hosted container. The base URL is
 * required rather than defaulted: there is no host that is right for both, and a
 * wrong default silently posts a customer's key to somebody else's server.
 */
const baseUrlSchema = z
	.url()
	.startsWith("http")
	.max(300)
	.transform((value) => value.replace(/\/+$/, ""))

export const saveSpeechEndpointSchema = z.object({
	baseUrl: baseUrlSchema,
	/**
	 * Optional on an update: omitting it keeps the stored key, so changing the
	 * model does not mean re-typing a secret the console can no longer show.
	 */
	apiKey: z.string().trim().min(8).max(400).optional(),
	model: z.string().trim().min(1).max(200),
	/**
	 * Required for synthesis and refused for transcription — a voice id means
	 * nothing to a transcription endpoint, and accepting one there would leave a
	 * value in the row that nothing reads.
	 */
	voice: z.string().trim().min(1).max(100).nullable().default(null),
})

export type SaveSpeechEndpointInput = z.infer<typeof saveSpeechEndpointSchema>

export const speechCapabilitySchema = z.enum(["stt", "tts"])
