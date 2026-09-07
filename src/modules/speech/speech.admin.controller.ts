import type { AppContext } from "../../api/types"
import { requireParam, requireUser } from "../../api/types"
import { ValidationError } from "../../shared/errors"
import { saveSpeechEndpointSchema, speechCapabilitySchema } from "./speech.admin.dto"
import { speechAdminService } from "./speech.admin.service"

/** `stt` or `tts`, refused at the edge so the service never sees another value. */
function capability(c: AppContext) {
	const parsed = speechCapabilitySchema.safeParse(requireParam(c, "capability"))
	if (!parsed.success) {
		throw new ValidationError("Speech has two halves: \"stt\" and \"tts\".")
	}
	return parsed.data
}

export const speechAdminController = {
	async get(c: AppContext) {
		return c.json(await speechAdminService.get())
	},

	async save(c: AppContext) {
		const actor = requireUser(c)
		const input = saveSpeechEndpointSchema.parse(await c.req.json())
		return c.json(await speechAdminService.save(capability(c), input, actor.id))
	},

	async remove(c: AppContext) {
		const actor = requireUser(c)
		return c.json(await speechAdminService.remove(capability(c), actor.id))
	},

	async check(c: AppContext) {
		const actor = requireUser(c)
		return c.json(await speechAdminService.check(capability(c), actor.id))
	},
}
