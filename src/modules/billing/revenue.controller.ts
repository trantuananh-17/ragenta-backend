import type { AppContext } from "../../api/types"
import { platformUsageQuerySchema } from "../usage/platform-usage.dto"
import { revenueService } from "./revenue.service"

/**
 * Its own controller rather than a method on `billing.controller`: everything
 * there is workspace-scoped and resolves a membership, and this is the opposite
 * — cross-tenant, and readable only with `admin.usage.read`.
 */
export const revenueController = {
	async overview(c: AppContext) {
		const query = platformUsageQuerySchema.parse(c.req.query())
		return c.json(await revenueService.overview(query))
	},
}
