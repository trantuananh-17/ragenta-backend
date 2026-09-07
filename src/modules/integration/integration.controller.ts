import type { AppContext } from "../../api/types"
import { requireParam, requireUser } from "../../api/types"
import { saveIntegrationSchema } from "./integration.dto"
import { integrationService } from "./integration.service"

export const integrationController = {
	async list(c: AppContext) {
		return c.json(await integrationService.list())
	},

	async get(c: AppContext) {
		return c.json(await integrationService.get(requireParam(c, "integrationId")))
	},

	async save(c: AppContext) {
		const user = requireUser(c)
		const input = saveIntegrationSchema.parse(await c.req.json())
		return c.json(
			await integrationService.save(requireParam(c, "integrationId"), input, user.id),
		)
	},

	async remove(c: AppContext) {
		const user = requireUser(c)
		await integrationService.remove(requireParam(c, "integrationId"), user.id)
		return c.body(null, 204)
	},

	async check(c: AppContext) {
		return c.json(await integrationService.check(requireParam(c, "integrationId")))
	},
}
