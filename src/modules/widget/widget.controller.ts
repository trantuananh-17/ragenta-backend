import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
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
