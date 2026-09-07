import { isSpeechToTextConfigured } from "../../../ai/speech"
import { isAppError } from "../../../shared/errors"
import { speechService } from "../../speech/speech.service"
import { renderTranscript, speechTranscribeParameters } from "./speech-content"
import type { AgentTool, ToolContext, ToolResult } from "./types"

/**
 * Turn a stored recording into text.
 *
 * A thin pass-through to `speechService.transcribeAttachment` on purpose, the
 * same shape `image_ocr` has over the vision service: the provider choice, the
 * credit floor, the transcript cache on `attachment.extracted` and the charge
 * are the speech module's, so a voice note transcribed in chat and one
 * transcribed in an agent run are the same call and the same answer.
 *
 * The cached-transcript rule lives in that service rather than being repeated
 * here — re-transcribing audio that has not changed would re-bill for it, and
 * the service short-circuits on `attachment.extracted` and reports it back as
 * `cached`. A second check in this file would be a second place for that rule to
 * be got wrong.
 */
export const speechTranscribeTool: AgentTool = {
	name: "speech_transcribe",
	description:
		"Transcribe an audio attachment — a voice note, a recorded call, a meeting clip — into text you can read and quote. Give it the attachment id, and the two-letter language code if you know what was spoken. A recording that has already been transcribed returns the same transcript at no cost.",
	parameters: speechTranscribeParameters,
	writes: false,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = speechTranscribeParameters.parse(args)

		if (!isSpeechToTextConfigured()) {
			return {
				ok: false,
				content:
					"This deployment has no speech-to-text configured, so recordings cannot be transcribed.",
				metadata: { attachmentId: input.attachmentId, refused: "stt_not_configured" },
			}
		}

		try {
			const transcript = await speechService.transcribeAttachment(
				// The workspace comes from the run and from nowhere else. The
				// attachment id came from the MODEL — it may have been read out of a
				// document, echoed from a web page or simply invented — and the service
				// resolves it through `findOrFail(workspaceId, …)`, which puts the
				// workspace in the WHERE clause, so an id belonging to another tenant
				// is a 404 here rather than audio this run gets to listen to
				// (`.claude/rules/security.md`).
				context.workspaceId,
				input.attachmentId,
				{ language: input.language },
				context.userId,
			)

			return {
				ok: true,
				content: renderTranscript(transcript),
				metadata: {
					attachmentId: transcript.attachmentId,
					cached: transcript.cached,
					language: transcript.language,
					durationSec: transcript.durationSec,
					characters: transcript.text.length,
					segments: transcript.segments.length,
				},
			}
		} catch (error) {
			// An attachment that is not audio, an id that resolves in no workspace of
			// ours, a workspace out of credits, a provider that gave up: every one of
			// them arrives as a domain error whose message already says what is wrong
			// in words the model can act on. A refusal rather than a throw, so a run
			// that has another way to answer still gets to take it (`types.ts`).
			return {
				ok: false,
				content: isAppError(error)
					? error.message
					: "That recording could not be transcribed.",
				metadata: {
					attachmentId: input.attachmentId,
					refused: isAppError(error) ? error.code : "transcribe_failed",
				},
			}
		}
	},
}
