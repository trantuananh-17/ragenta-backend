import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import { synthesizeSpeechSchema, transcribeAttachmentSchema } from "./speech.dto"
import { speechService } from "./speech.service"

/** A body-less transcribe is the ordinary call — the language hint is optional. */
async function readOptionalJson(c: AppContext): Promise<unknown> {
	if (!c.req.header("content-type")?.includes("application/json")) return {}
	return c.req.json().catch(() => ({}))
}

export const speechController = {
	async transcribe(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = transcribeAttachmentSchema.parse(await readOptionalJson(c))

		return c.json(
			await speechService.transcribeAttachment(
				membership.organizationId,
				requireParam(c, "attachmentId"),
				input,
				user.id,
			),
		)
	},

	async synthesize(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = synthesizeSpeechSchema.parse(await c.req.json())

		const result = await speechService.synthesize(
			membership.organizationId,
			input,
			user.id,
		)

		c.header("Content-Type", result.mimeType)
		// Generated per request and charged for; a shared cache holding one member's
		// audio for another to receive is not a saving worth having.
		c.header("Cache-Control", "private, no-store")
		if (result.sampleRate) c.header("X-Audio-Sample-Rate", String(result.sampleRate))

		// Copied into a plain view because a Buffer may be backed by Node's shared
		// allocation pool, whose `.buffer` is the whole pool rather than this audio.
		return c.body(new Uint8Array(result.audio).buffer)
	},
}
