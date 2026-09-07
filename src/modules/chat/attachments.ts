import { truncateToTokens } from "../../ai/tokens"
import type { AttachmentRow } from "./chat.repository"
import { renderFileText } from "../agent/tools/image-content"

/**
 * How many images one request may carry, counting the current question and
 * everything pulled forward out of the thread.
 *
 * Four rather than "all of them" because an image is not history the way a
 * sentence is. Every provider bills an image as input tokens on every turn that
 * carries it — a screenshot is on the order of a thousand of them — so a thread
 * that kept ten images alive would re-buy all ten on every follow-up, forever,
 * and the tenth turn would cost more than the first ten put together. Four is
 * enough for the case this exists for: an image, a question about it, and a
 * couple of follow-ups that are still about the same picture.
 */
export const MAX_TURN_IMAGES = 4

/** How much of an extraction goes into the prompt in place of the image. */
const MAX_EXTRACTION_TOKENS = 1_000

/** The same budget as a character cap, for the fence helper's own limit. */
const MAX_EXTRACTION_CHARACTERS = MAX_EXTRACTION_TOKENS * 4

/**
 * An attachment as the prompt builder sees it: no row, no bucket, nothing that
 * needs a database to reason about, so the selection rule below is a pure
 * function and can be tested as one.
 */
export interface TurnAttachment {
	id: string
	fileName: string
	mimeType: string
	/** image | audio | file. Decides whether bytes can be sent at all. */
	kind: string
	/**
	 * The OCR/vision result for an image, or the transcript for a recording —
	 * whichever has already been produced for this file.
	 */
	extractedText: string | null
}

export interface ImagePlan {
	/** Fetched from storage and sent as bytes, oldest first. */
	inline: TurnAttachment[]
	/** Represented in the prompt by their extracted text instead of their bytes. */
	transcribed: TurnAttachment[]
	/** Past the cap with no extraction to fall back to, so nothing of them is sent. */
	dropped: TurnAttachment[]
}

/**
 * Decides which images a turn actually sends.
 *
 * History matters here and is the whole reason this is not just "attach what
 * was uploaded": someone sends an invoice, asks what it is, then asks for the
 * total. The second question is unanswerable if the picture only existed for
 * the first, so images from earlier turns are carried forward too.
 *
 * Two rules, in this order:
 *
 * 1. A historical image that has already been read — OCR or a vision pass wrote
 *    `extracted` — goes in as its text and never as bytes. That is both cheaper
 *    (a page of text costs a fraction of the image it came from) and more
 *    precise: "what was the total again" is answered from a transcription that
 *    was made once, not from a model re-reading the same pixels every turn and
 *    possibly reading them differently.
 * 2. Whatever is left competes for `MAX_TURN_IMAGES` slots, most recent first.
 *    The current question's own attachments are the most recent by definition,
 *    so they always win — a turn never drops the image it is about in order to
 *    keep one from four turns ago.
 *
 * `current` is in the order the user attached them; `history` is oldest first.
 */
export function planTurnImages(
	current: TurnAttachment[],
	history: TurnAttachment[],
	limit: number = MAX_TURN_IMAGES,
): ImagePlan {
	// Only an image can be sent as bytes. No chat model in this deployment takes
	// audio on the wire — a recording reaches the model as its transcript or not
	// at all — so audio never competes for an image slot, whether it is from this
	// turn or an earlier one.
	const spoken = [...history, ...current].filter((entry) => entry.kind !== "image")
	const currentImages = current.filter((entry) => entry.kind === "image")
	const historyImages = history.filter((entry) => entry.kind === "image")

	const transcribed = [
		...historyImages.filter((entry) => entry.extractedText !== null),
		...spoken.filter((entry) => entry.extractedText !== null),
	]
	const candidates = [
		...historyImages.filter((entry) => entry.extractedText === null),
		...currentImages,
	]

	const keep = Math.max(0, limit)
	return {
		inline: keep === 0 ? [] : candidates.slice(-keep),
		transcribed,
		dropped: candidates.slice(0, Math.max(0, candidates.length - keep)),
	}
}

/**
 * Puts an earlier image's extracted text back into the message it belonged to.
 *
 * Labelled and fenced, because it is text a model read out of a file a user
 * supplied. It is data in a prompt and never an instruction, whatever it says —
 * the same rule the retrieved passages in `prompt.ts` are held to
 * (`.claude/rules/security.md`).
 */
export function withExtractedText(content: string, attachments: TurnAttachment[]): string {
	if (attachments.length === 0) return content

	const blocks = attachments.map((entry) => {
		const text = truncateToTokens(entry.extractedText ?? "", MAX_EXTRACTION_TOKENS)
		// Named for what it is. "Text read from this image" and "transcript of
		// this recording" are different claims about how reliable the words are,
		// and the model should not have to guess which one it is reading.
		//
		// Fenced through the same helper the agent tools use, rather than by a
		// label alone. This block is appended to the *user's own message*, so
		// without a delimiter there is nothing marking where the file's content
		// ends — and the content is words a model read off a file somebody
		// uploaded. A label is a description; a fence is a boundary.
		const source =
			entry.kind === "audio"
				? `a recording, ${entry.fileName} — transcript follows`
				: `an image, ${entry.fileName} — text read from it follows`
		return renderFileText(source, text, MAX_EXTRACTION_CHARACTERS)
	})

	return content.length > 0 ? `${content}\n\n${blocks.join("\n\n")}` : blocks.join("\n\n")
}

/**
 * An attachment as a transcript shows it.
 *
 * `storageKey` is absent for the reason `attachment.dto.ts` gives: it is a
 * bucket path, and a reader that never needs one should never be handed one.
 */
export interface MessageAttachmentSummary {
	id: string
	kind: string
	fileName: string
	mimeType: string
	width: number | null
	height: number | null
}

export function toMessageAttachment(row: AttachmentRow): MessageAttachmentSummary {
	return {
		id: row.id,
		kind: row.kind,
		fileName: row.fileName,
		mimeType: row.mimeType,
		width: row.width,
		height: row.height,
	}
}
