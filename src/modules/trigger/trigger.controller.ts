import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import { saveTriggerSchema } from "./trigger.dto"
import { triggerService } from "./trigger.service"

export const triggerController = {
	async list(c: AppContext) {
		const membership = requireMembership(c)
		const triggers = await triggerService.list(
			membership.organizationId,
			requireParam(c, "agentId"),
		)
		return c.json({ triggers })
	},

	async create(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = saveTriggerSchema.parse(await c.req.json())
		const created = await triggerService.create(
			membership.organizationId,
			requireParam(c, "agentId"),
			input,
			user.id,
		)
		// The secret is in this response and in no other, because it is stored
		// hashed and there is nothing to show afterwards.
		return c.json(created, 201)
	},

	async update(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = saveTriggerSchema.parse(await c.req.json())
		const trigger = await triggerService.update(
			membership.organizationId,
			requireParam(c, "triggerId"),
			input,
			user.id,
		)
		return c.json({ trigger })
	},

	async remove(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		await triggerService.remove(
			membership.organizationId,
			requireParam(c, "triggerId"),
			user.id,
		)
		return c.body(null, 204)
	},

	/**
	 * The public webhook. No session — the secret in the header is the credential,
	 * and the response says only that a run was queued.
	 */
	async fire(c: AppContext) {
		const secret = c.req.header("x-ragenta-secret") ?? ""
		const body = await c.req.text()
		const queued = await triggerService.fireWebhook(requireParam(c, "triggerId"), secret, body)
		return c.json(queued, 202)
	},
}
