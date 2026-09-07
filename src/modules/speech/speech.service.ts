import {
	MAX_AUDIO_DURATION_SECONDS,
	SpeechUnavailableError,
	defaultSpeechVoice,
	requireSpeechToText,
	requireTextToSpeech,
	resolvedSpeechEndpoint,
} from "../../ai/speech"
import type { SpeechResult } from "../../ai/speech"
import { ConflictError, EntitlementError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import { getObject } from "../../storage/objects"
import { attachmentRepository } from "../attachment/attachment.repository"
import { attachmentService } from "../attachment/attachment.service"
import { billingService } from "../billing/billing.service"
import { priceSpeechUsage } from "../usage/pricing"
import { usageService } from "../usage/usage.service"
import { toTranscriptExtraction, toTranscriptResponse } from "./speech.dto"
import { billableDuration } from "./duration"
import type {
	SynthesizeSpeechInput,
	TranscribeAttachmentInput,
	TranscriptResponse,
} from "./speech.dto"

const log = logger.child({ module: "speech" })

/**
 * Transcription and synthesis, as one domain service both the API and a future
 * agent tool call.
 *
 * **Transcription runs inside the request, and that is a real limit.** Against
 * the hosted OpenAI API it returns in a few seconds whatever the length. Against
 * a self-hosted CPU sidecar it runs at roughly real time, so a five-minute
 * recording holds the connection — and one Node request — for about five
 * minutes, and a handful of them exhausts the API container while every other
 * endpoint queues behind them. Long-form audio belongs on a `QUEUE_SPEECH`
 * BullMQ queue with the attachment moving through `processing` to `ready`, which
 * is the follow-up to this and deliberately not built here: the read-aloud and
 * voice-note cases this serves are short clips, and a queue would make the
 * common case slower to ship and slower to use.
 */

/**
 * The upload cap bounds bytes, not time, and there is no way to know a
 * recording's duration before something decodes it — so the request itself
 * carries the ceiling. A transcription still running after the longest audio we
 * accept could have taken at real time is not going to finish usefully.
 */
const TRANSCRIBE_TIMEOUT_MS = MAX_AUDIO_DURATION_SECONDS * 1_000

/**
 * The credit floor a transcription must clear before the provider is called,
 * priced as two minutes of audio. It is a floor rather than an exact charge for
 * the reason the timeout exists: the duration is unknown until the transcript
 * comes back, and refusing after the money has been spent at the provider helps
 * nobody. The real charge is made from the duration the provider reports.
 */
const MINIMUM_TRANSCRIBE_CREDITS = priceSpeechUsage({ seconds: 120 }).credits

/**
 * Whisper servers decide how to decode from the filename's extension, so a name
 * with the wrong one fails to decode audio that is perfectly good. Built from
 * the type that was sniffed at upload, never from what the uploader called the
 * file.
 */
const AUDIO_EXTENSIONS: Record<string, string> = {
	"audio/webm": "webm",
	"audio/ogg": "ogg",
	"audio/mpeg": "mp3",
	"audio/mp4": "m4a",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/flac": "flac",
}

export const speechService = {
	/**
	 * Transcribes a stored recording, once.
	 *
	 * The transcript is written to `attachment.extracted`, so a second call — a
	 * reload, a retry, another member opening the thread — returns what is already
	 * there and charges nothing. That is the same rule the image path follows for
	 * an OCR result, and it is what makes the charge safe to make unconditionally
	 * below.
	 */
	async transcribeAttachment(
		workspaceId: string,
		attachmentId: string,
		input: TranscribeAttachmentInput,
		/** Null for a run with no human actor — an API-key or scheduled run.
		 * `usage_ledger.user_id` and `message_attachment.user_id` are nullable FKs,
		 * so null is the correct value; an empty string would violate them. */
		actorId: string | null,
	): Promise<TranscriptResponse> {
		// Workspace-scoped: the id in the URL proves nothing on its own.
		const row = await attachmentService.findOrFail(workspaceId, attachmentId)

		if (row.kind !== "audio") {
			throw new ValidationError("This attachment is not a recording, so it cannot be transcribed.")
		}
		if (row.extracted) return toTranscriptResponse(row.id, row.extracted, true)
		if (row.status === "processing") {
			throw new ConflictError("This recording is already being transcribed.")
		}

		const config = await resolvedSpeechEndpoint("stt")
		if (!config) throw new SpeechUnavailableError("transcription")
		const provider = await requireSpeechToText()

		const summary = await billingService.getSummary(workspaceId)
		if (summary.credits.total < MINIMUM_TRANSCRIBE_CREDITS) {
			throw new EntitlementError(
				"INSUFFICIENT_CREDITS",
				"This workspace does not have enough credits to transcribe a recording.",
				{ required: MINIMUM_TRANSCRIBE_CREDITS, available: summary.credits.total },
			)
		}

		await attachmentRepository.update(workspaceId, row.id, { status: "processing", error: null })

		const audio = await getObject(row.storageKey)
		const extension = AUDIO_EXTENSIONS[row.mimeType] ?? "webm"

		let transcript
		try {
			transcript = await provider.transcribe(
				{
					audio,
					mimeType: row.mimeType,
					fileName: `${row.id}.${extension}`,
					language: input.language,
				},
				AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
			)
		} catch (error) {
			await attachmentRepository.update(workspaceId, row.id, {
				status: "failed",
				// Bounded and stored as the uploader's explanation, not as the
				// provider's raw response.
				error: "The recording could not be transcribed.",
			})
			log.warn("speech.transcribe_failed", {
				workspaceId,
				attachmentId: row.id,
				provider: provider.id,
				error: String(error),
			})
			throw error
		}

		// Untrusted content from here on: this is text a model read out of a file a
		// user supplied (`.claude/rules/security.md`).
		const extraction = toTranscriptExtraction(transcript, provider.id, config.model)
		const durationSec = transcript.durationSec ?? null

		await attachmentRepository.update(workspaceId, row.id, {
			status: "ready",
			error: null,
			extracted: extraction,
			durationMs: durationSec === null ? null : Math.round(durationSec * 1_000),
		})

		// Charged on what the provider says it processed, and on a size-derived
		// floor when it says nothing. `verbose_json` is a request rather than a
		// guarantee — a self-hosted server may answer plain `{ text }`, and
		// OpenAI's own gpt-4o-transcribe refuses the format outright — and charging
		// zero for those is not caution but unlimited free transcription against a
		// real bill. The estimate is deliberately low (`duration.ts`) so the error
		// is ours, and the row says which of the two it was.
		const billable = billableDuration(durationSec, row.sizeBytes, row.mimeType)
		if (billable.estimated) {
			log.warn("speech.duration_estimated", {
				attachmentId: row.id,
				model: config.model,
				sizeBytes: row.sizeBytes,
				seconds: billable.seconds,
			})
		}

		await usageService.recordAndCharge({
			workspaceId,
			userId: actorId,
			operation: "speech",
			provider: provider.id,
			model: config.model,
			speechUnits: { seconds: billable.seconds },
			// Stable per attachment, and the row is only reachable once because the
			// extraction short-circuits every later call.
			reference: `speech:transcribe:${row.id}`,
			metadata: {
				attachmentId: row.id,
				seconds: billable.seconds,
				reportedSeconds: durationSec,
				estimated: billable.estimated,
				language: transcript.language,
			},
		})

		return toTranscriptResponse(row.id, extraction, false)
	},

	/**
	 * Speaks a piece of text.
	 *
	 * Generic on purpose, and not tied to a message or an attachment: read-aloud
	 * in the chat UI and a Phase 4 agent tool that answers out loud are the same
	 * request, and a second endpoint for the second caller would be a second place
	 * to forget the credit check.
	 */
	/**
	 * `reference` is accepted for a caller that genuinely has a stable identity
	 * for one synthesis, but there is no such caller today and the default is the
	 * right answer for both of them.
	 *
	 * Every call that gets past the credit check makes a real, billable request to
	 * the provider, so every call is a real charge: the same text spoken twice
	 * from the composer is two syntheses, and a `tts` node retried after a failure
	 * synthesised the audio twice. Deduplicating either would bill one call and
	 * make two. A caller passing a reference here is asserting that its repeats
	 * are the *same* provider call, not merely the same text.
	 */
	async synthesize(
		workspaceId: string,
		input: SynthesizeSpeechInput,
		actorId: string | null,
		reference?: string,
	) {
		const config = await resolvedSpeechEndpoint("tts")
		if (!config) throw new SpeechUnavailableError("synthesis")
		const provider = await requireTextToSpeech()

		const voice = input.voice ?? (await defaultSpeechVoice())
		if (!voice) throw new SpeechUnavailableError("synthesis")

		// The exact cost is known before the call here — characters are counted, not
		// reported back — so the refusal is for what this call will actually charge.
		const characters = input.text.length
		const { credits } = priceSpeechUsage({ characters })
		const summary = await billingService.getSummary(workspaceId)
		if (summary.credits.total < credits) {
			throw new EntitlementError(
				"INSUFFICIENT_CREDITS",
				"This workspace does not have enough credits to generate speech.",
				{ required: credits, available: summary.credits.total },
			)
		}

		const result: SpeechResult = await provider.synthesize({
			text: input.text,
			voice,
			format: input.format,
			speed: input.speed,
		})

		await usageService.recordAndCharge({
			workspaceId,
			userId: actorId,
			operation: "speech",
			provider: provider.id,
			model: config.model,
			speechUnits: { characters },
			// A caller's own reference when it has one, and a fresh id otherwise.
			// Nothing durable identifies a synthesis on its own — the same text may
			// legitimately be spoken twice — so without a caller-supplied identity
			// the unique index can only guard one call, not deduplicate across
			// attempts of the same one.
			reference: reference ?? `speech:synthesize:${newId()}`,
			metadata: { characters, voice, format: input.format },
		})

		return result
	},
}
