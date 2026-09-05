import type { AppContext } from "../../api/types"
import { requireParam, requireUser } from "../../api/types"
import {
	patchModelSchema,
	saveCredentialSchema,
	setPlatformDefaultsSchema,
	upsertModelSchema,
} from "./provider.dto"
import { providerService } from "./provider.service"

export const providerController = {
	async list(c: AppContext) {
		return c.json(await providerService.listProviders())
	},

	async saveCredential(c: AppContext) {
		const actor = requireUser(c)
		const input = saveCredentialSchema.parse(await c.req.json())
		return c.json(
			await providerService.saveCredential(requireParam(c, "provider"), input, actor.id),
		)
	},

	async removeCredential(c: AppContext) {
		const actor = requireUser(c)
		return c.json(
			await providerService.removeCredential(requireParam(c, "provider"), actor.id),
		)
	},

	async checkCredential(c: AppContext) {
		const actor = requireUser(c)
		return c.json(
			await providerService.checkCredential(requireParam(c, "provider"), actor.id),
		)
	},

	async upsertModel(c: AppContext) {
		const actor = requireUser(c)
		const input = upsertModelSchema.parse(await c.req.json())
		return c.json(await providerService.upsertModel(input, actor.id), 201)
	},

	async patchModel(c: AppContext) {
		const actor = requireUser(c)
		const patch = patchModelSchema.parse(await c.req.json())
		return c.json(
			await providerService.patchModel(
				requireParam(c, "provider"),
				// Some catalogues spell a model with a colon or a slash (Ollama tags),
				// so the caller percent-encodes it into one path segment.
				decodeURIComponent(requireParam(c, "model")),
				patch,
				actor.id,
			),
		)
	},

	async removeModel(c: AppContext) {
		const actor = requireUser(c)
		return c.json(
			await providerService.removeModel(
				requireParam(c, "provider"),
				decodeURIComponent(requireParam(c, "model")),
				actor.id,
			),
		)
	},

	async getDefaults(c: AppContext) {
		return c.json(await providerService.getPlatformDefaults())
	},

	async setDefaults(c: AppContext) {
		const actor = requireUser(c)
		const input = setPlatformDefaultsSchema.parse(await c.req.json())
		return c.json(await providerService.setPlatformDefaults(input, actor.id))
	},
}
