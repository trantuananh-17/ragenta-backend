import type { AppContext } from "../../api/types"
import { requireMembership, requireUser } from "../../api/types"
import { updateModelSettingsSchema } from "./model.dto"
import { modelService } from "./model.service"

export const modelController = {
	async list(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(await modelService.listModels(membership.organizationId))
	},

	async getSettings(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(await modelService.getSettings(membership.organizationId))
	},

	async updateSettings(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = updateModelSettingsSchema.parse(await c.req.json())
		return c.json(
			await modelService.updateSettings(membership.organizationId, input, user.id),
		)
	},
}
