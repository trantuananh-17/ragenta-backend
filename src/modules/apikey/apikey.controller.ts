import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import { createApiKeySchema } from "./apikey.dto"
import { apiKeyService } from "./apikey.service"

export const apiKeyController = {
	async list(c: AppContext) {
		const membership = requireMembership(c)
		return c.json({ keys: await apiKeyService.list(membership.organizationId) })
	},

	async create(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = createApiKeySchema.parse(await c.req.json())
		const created = await apiKeyService.create(membership, input, user.id)
		// The plaintext is here and in no other response.
		return c.json(created, 201)
	},

	async revoke(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		await apiKeyService.revoke(membership.organizationId, requireParam(c, "keyId"), user.id)
		return c.body(null, 204)
	},
}
