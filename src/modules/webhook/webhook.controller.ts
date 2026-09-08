import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import { WEBHOOK_EVENTS } from "./events"
import { saveWebhookEndpointSchema } from "./webhook.dto"
import { webhookService } from "./webhook.service"

export const webhookController = {
	async list(c: AppContext) {
		const membership = requireMembership(c)
		return c.json({
			endpoints: await webhookService.list(membership.organizationId),
			// Sent with the list rather than from its own endpoint: a screen that
			// shows subscriptions needs the catalogue to render them, and a second
			// round trip for four compiled-in rows is a round trip for nothing.
			events: WEBHOOK_EVENTS,
		})
	},

	async create(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = saveWebhookEndpointSchema.parse(await c.req.json())
		const created = await webhookService.create(membership.organizationId, input, user.id)
		return c.json(created, 201)
	},

	async update(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = saveWebhookEndpointSchema.parse(await c.req.json())
		const endpoint = await webhookService.update(
			membership.organizationId,
			requireParam(c, "endpointId"),
			input,
			user.id,
		)
		return c.json({ endpoint })
	},

	async rotateSecret(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		return c.json(
			await webhookService.rotateSecret(
				membership.organizationId,
				requireParam(c, "endpointId"),
				user.id,
			),
		)
	},

	async remove(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		await webhookService.remove(
			membership.organizationId,
			requireParam(c, "endpointId"),
			user.id,
		)
		return c.body(null, 204)
	},

	async listDeliveries(c: AppContext) {
		const membership = requireMembership(c)
		const endpointId = c.req.query("endpointId")
		return c.json({
			deliveries: await webhookService.listDeliveries(
				membership.organizationId,
				endpointId || undefined,
			),
		})
	},
}
