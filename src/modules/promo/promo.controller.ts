import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import { paginationQuerySchema } from "../../shared/pagination"
import {
	createPromoCodeSchema,
	listPromoCodesQuerySchema,
	redeemPromoCodeSchema,
	updatePromoCodeSchema,
} from "./promo.dto"
import { promoService } from "./promo.service"

export const promoController = {
	async list(c: AppContext) {
		const query = paginationQuerySchema.parse(c.req.query())
		const { search } = listPromoCodesQuerySchema.parse(c.req.query())
		return c.json(await promoService.list(search, query))
	},

	async create(c: AppContext) {
		const actor = requireUser(c)
		const input = createPromoCodeSchema.parse(await c.req.json())
		return c.json(await promoService.create(input, actor.id), 201)
	},

	async update(c: AppContext) {
		const actor = requireUser(c)
		const { active } = updatePromoCodeSchema.parse(await c.req.json())
		return c.json(
			await promoService.setActive(requireParam(c, "promoCodeId"), active, actor.id),
		)
	},

	async remove(c: AppContext) {
		const actor = requireUser(c)
		await promoService.remove(requireParam(c, "promoCodeId"), actor.id)
		return c.body(null, 204)
	},

	async listRedemptions(c: AppContext) {
		const query = paginationQuerySchema.parse(c.req.query())
		return c.json(await promoService.listRedemptions(requireParam(c, "promoCodeId"), query))
	},

	// ── Workspace side ─────────────────────────────────────────────────────────

	async redeem(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const { code } = redeemPromoCodeSchema.parse(await c.req.json())
		return c.json(await promoService.redeem(membership.organizationId, code, user.id))
	},

	async listWorkspaceRedemptions(c: AppContext) {
		const membership = requireMembership(c)
		return c.json({
			items: await promoService.listWorkspaceRedemptions(membership.organizationId),
		})
	},
}
