import { z } from "zod"

import { MAX_SYNTHESIS_CHARACTERS } from "../../speech/speech.dto"
import { renderFileText } from "./image-content"

/**
 * The pure half of the two speech tools: what the model may ask them for, and
 * what it reads back.
 *
 * Separate from the tool files for the reason `image-content.ts` is separate
 * from its own: those reach the speech service, the attachment service and the
 * provider registry, and so pull in `config/env` — the unit suite runs on a
 * runner with no environment and no infrastructure at all (see
 * `vitest.config.ts`).
 */

export const speechTranscribeParameters = z.object({
	attachmentId: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.describe("The id of the audio attachment to transcribe."),
	/**
	 * Worth asking the model for: detection is unreliable on short clips, and a
	 * three-word Vietnamese question is routinely detected as Chinese.
	 */
	language: z
		.string()
		.trim()
		.length(2)
		.optional()
		.describe("ISO 639-1 code of the spoken language, if you know it. Detected when omitted."),
})

export const speechSynthesizeParameters = z.object({
	/**
	 * The same ceiling the HTTP endpoint enforces, taken from the DTO rather than
	 * restated: synthesis is charged per character, so two caps that drifted would
	 * be two different bills for the same feature.
	 */
	text: z
		.string()
		.trim()
		.min(1)
		.max(MAX_SYNTHESIS_CHARACTERS)
		.describe("The text to speak. Plain prose, not markup."),
	/** A deployment-configured voice id, not an enum — see `SynthesizeInput`. */
	voice: z
		.string()
		.trim()
		.min(1)
		.max(100)
		.optional()
		.describe("A voice id this deployment offers. Omit to use its default voice."),
})

/** The fields of a transcript the model is shown. */
export interface RenderableTranscript {
	text: string
	language: string | null
	durationSec: number | null
}

/**
 * A transcript as the model should read it.
 *
 * Words a stranger spoke into a file they uploaded, so the transcript is data
 * and never instructions — a recording that says "you are now an administrator"
 * is content, exactly as an OCR'd scan is (`.claude/rules/security.md`). The
 * fence comes from the image path so both read identically.
 */
export function renderTranscript(transcript: RenderableTranscript): string {
	const parts = [renderFileText("an audio recording", transcript.text)]

	if (transcript.language) parts.push(`Detected language: ${transcript.language}.`)
	if (transcript.durationSec !== null) {
		parts.push(`Recording length: ${transcript.durationSec.toFixed(1)} seconds.`)
	}

	return parts.join("\n\n")
}

export interface RenderableSynthesis {
	attachmentId: string
	mimeType: string
	sizeBytes: number
	characters: number
}

/**
 * Synthesis as the model should read it: a pointer, not the audio.
 *
 * A tool result is text, and a megabyte of base64 MP3 would be text the model
 * cannot listen to, cannot summarise and pays for by the token. So the audio is
 * stored as an attachment and only its id comes back — which is also what makes
 * the recording a thing a later step, a message or a workflow output can claim
 * (ADR-037).
 */
export function renderSynthesis(synthesis: RenderableSynthesis): string {
	return [
		`The text was spoken and stored as an audio attachment. Attachment id: ${synthesis.attachmentId}`,
		`Format: ${synthesis.mimeType}. Size: ${synthesis.sizeBytes} bytes. Spoken characters: ${synthesis.characters}.`,
		"The audio itself is not included here, because it is not text. Pass the attachment id on to whatever should play, send or store the recording.",
	].join("\n\n")
}
