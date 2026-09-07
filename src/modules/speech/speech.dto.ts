import { z } from "zod"

import type { SpeechAudioFormat, TranscriptResult, TranscriptSegment } from "../../ai/speech/types"
import type { AttachmentExtraction } from "../../db/schema"

/**
 * Speech at the API edge.
 *
 * Transcription reuses `attachment.extracted` rather than a table of its own,
 * for the reason the column exists: a transcript is a normalised reading of a
 * user-supplied file, exactly like an OCR pass, and keeping it there is what
 * stops a second read of a thread paying to transcribe the same recording
 * again.
 */

/**
 * Declared against the provider union rather than restated, so a format added
 * to `SpeechAudioFormat` that nobody wires up here fails to compile instead of
 * quietly being unreachable.
 */
const SPEECH_AUDIO_FORMATS = [
	"mp3",
	"opus",
	"aac",
	"flac",
	"wav",
	"pcm",
] as const satisfies readonly SpeechAudioFormat[]

/**
 * About a page and a half of prose. The cap is here rather than in the service
 * because it is the request that has to be bounded: synthesis is charged per
 * character and held open for the whole generation, so an unbounded body is both
 * an unbounded bill and an unbounded request.
 */
export const MAX_SYNTHESIS_CHARACTERS = 4_000

export const synthesizeSpeechSchema = z.object({
	text: z.string().trim().min(1).max(MAX_SYNTHESIS_CHARACTERS),
	/**
	 * A deployment-configured voice id, not an enum — see `SynthesizeInput`.
	 * Absent uses the one this deployment configured.
	 */
	voice: z.string().trim().min(1).max(100).optional(),
	format: z.enum(SPEECH_AUDIO_FORMATS).default("mp3"),
	speed: z.number().min(0.25).max(4).optional(),
})

export const transcribeAttachmentSchema = z.object({
	/**
	 * ISO 639-1. Worth sending: detection is unreliable on short clips, and a
	 * three-word Vietnamese question is routinely detected as Chinese.
	 */
	language: z.string().trim().length(2).optional(),
})

export type SynthesizeSpeechInput = z.infer<typeof synthesizeSpeechSchema>
export type TranscribeAttachmentInput = z.infer<typeof transcribeAttachmentSchema>

/**
 * The transcript's own fields, carried in the extraction's `metadata`.
 *
 * `AttachmentExtraction` is shared with OCR and its shape is owned by the
 * schema, so the speech-specific parts extend it here instead of widening it
 * there — a jsonb column holds this happily and every existing reader keeps
 * working, because it is still an `AttachmentExtraction`.
 */
export type TranscriptMetadata = AttachmentExtraction["metadata"] & {
	language?: string
	durationSec?: number
	segments?: TranscriptSegment[]
}

export interface TranscriptExtraction extends AttachmentExtraction {
	metadata: TranscriptMetadata
}

export interface TranscriptResponse {
	attachmentId: string
	/**
	 * Untrusted. This is text a model read out of a recording somebody uploaded,
	 * so every consumer — a prompt, an agent step, a UI — treats it as data and
	 * never as instructions (`.claude/rules/security.md`).
	 */
	text: string
	language: string | null
	durationSec: number | null
	segments: TranscriptSegment[]
	/** True when the transcript was already on the row, so nothing was charged. */
	cached: boolean
}

export function toTranscriptExtraction(
	result: TranscriptResult,
	provider: string,
	model: string,
): TranscriptExtraction {
	return {
		text: result.text,
		// A transcript has neither, and inventing shapes for them would make an
		// OCR reader think it found tables in a recording.
		tables: [],
		fields: {},
		metadata: {
			provider,
			model,
			language: result.language,
			durationSec: result.durationSec,
			segments: result.segments,
		},
	}
}

export function toTranscriptResponse(
	attachmentId: string,
	extraction: AttachmentExtraction,
	cached: boolean,
): TranscriptResponse {
	// The column's declared type is the shared one; the speech fields are known
	// to be there only because this module wrote them.
	const metadata = extraction.metadata as TranscriptMetadata

	return {
		attachmentId,
		text: extraction.text,
		language: metadata.language ?? null,
		durationSec: metadata.durationSec ?? null,
		segments: metadata.segments ?? [],
		cached,
	}
}
