import type { AppContext } from "../../api/types"
import { paginationQuerySchema } from "../../shared/pagination"
import { platformUsageQuerySchema } from "../usage/platform-usage.dto"
import { paymentRepository } from "./payment.repository"
import { page } from "../../shared/pagination"
import { revenueService } from "./revenue.service"

/**
 * Its own controller rather than a method on `billing.controller`: everything
 * there is workspace-scoped and resolves a membership, and this is the opposite
 * — cross-tenant, and readable only with `admin.usage.read`.
 */
export const revenueController = {
	/**
	 * Every payment across every workspace.
	 *
	 * Thin enough to read the repository directly: there is no rule to apply — the
	 * filtering is in the statement and the permission is on the route.
	 */
	async payments(c: AppContext) {
		const query = paginationQuerySchema.parse(c.req.query())
		const { workspaceId, status } = c.req.query()
		const { items, total } = await paymentRepository.listAll({ workspaceId, status }, query)
		return c.json(page(items, total, query))
	},

	async overview(c: AppContext) {
		const query = platformUsageQuerySchema.parse(c.req.query())
		return c.json(await revenueService.overview(query))
	},
}
