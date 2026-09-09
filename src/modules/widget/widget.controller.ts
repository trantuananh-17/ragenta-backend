import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import { platformUsageQuerySchema } from "../usage/platform-usage.dto"
import { saveWidgetSchema } from "./widget.dto"
import { widgetService } from "./widget.service"

export const widgetController = {
	async list(c: AppContext) {
		const membership = requireMembership(c)
		return c.json({ widgets: await widgetService.list(membership.organizationId) })
	},

	async save(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = saveWidgetSchema.parse(await c.req.json())
		const widget = await widgetService.save(membership.organizationId, input, user.id)
		return c.json({ widget })
	},

	/**
	 * Reuses the spend report's range parser rather than growing a second one. It
	 * validates `from`, `to` and a limit and resolves them to UTC day boundaries,
	 * which is the same question this screen asks even though it is a workspace's
	 * own widget rather than the whole platform.
	 */
	async usage(c: AppContext) {
		const membership = requireMembership(c)
		const { from, to, limit } = platformUsageQuerySchema.parse(c.req.query())
		return c.json(
			await widgetService.usage(
				membership.organizationId,
				requireParam(c, "widgetId"),
				from,
				to,
				limit,
			),
		)
	},

	async remove(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		await widgetService.remove(
			membership.organizationId,
			requireParam(c, "widgetId"),
			user.id,
		)
		return c.body(null, 204)
	},
}
