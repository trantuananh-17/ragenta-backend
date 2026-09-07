import type { AppContext } from "../../api/types"
import { requireParam, requireUser } from "../../api/types"
import { connectionSlugSchema, saveIntegrationSchema } from "./integration.dto"
import { integrationService } from "./integration.service"

/**
 * Two owners, one service. The admin handlers pass `null` — the platform-wide
 * connections — and the workspace handlers pass the id `workspaceScope` already
 * proved membership of. Neither reads an owner out of the body.
 */
export const integrationController = {
	async list(c: AppContext) {
		return c.json(await integrationService.list(null))
	},

	async get(c: AppContext) {
		return c.json(await integrationService.get(null, requireParam(c, "integrationId")))
	},

	async save(c: AppContext) {
		const user = requireUser(c)
		const input = saveIntegrationSchema.parse(await c.req.json())
		return c.json(
			await integrationService.save(null, requireParam(c, "integrationId"), input, user.id),
		)
	},

	async remove(c: AppContext) {
		const user = requireUser(c)
		await integrationService.remove(null, requireParam(c, "integrationId"), user.id)
		return c.body(null, 204)
	},

	async check(c: AppContext) {
		return c.json(await integrationService.check(null, requireParam(c, "integrationId")))
	},
}

/** The workspace's own connections, under `/v1/workspaces/:workspaceId/connections`. */
export const connectionController = {
	async list(c: AppContext) {
		return c.json(await integrationService.list(requireParam(c, "workspaceId")))
	},

	async get(c: AppContext) {
		return c.json(
			await integrationService.get(
				requireParam(c, "workspaceId"),
				connectionSlugSchema.parse(requireParam(c, "connectionId")),
			),
		)
	},

	async save(c: AppContext) {
		const user = requireUser(c)
		const input = saveIntegrationSchema.parse(await c.req.json())
		return c.json(
			await integrationService.save(
				requireParam(c, "workspaceId"),
				connectionSlugSchema.parse(requireParam(c, "connectionId")),
				input,
				user.id,
			),
		)
	},

	async remove(c: AppContext) {
		const user = requireUser(c)
		await integrationService.remove(
			requireParam(c, "workspaceId"),
			connectionSlugSchema.parse(requireParam(c, "connectionId")),
			user.id,
		)
		return c.body(null, 204)
	},

	async check(c: AppContext) {
		return c.json(
			await integrationService.check(
				requireParam(c, "workspaceId"),
				connectionSlugSchema.parse(requireParam(c, "connectionId")),
			),
		)
	},
}
