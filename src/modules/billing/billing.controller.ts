import type { AppContext } from "../../api/types"
import { requireMembership } from "../../api/types"
import { paginationQuerySchema } from "../../shared/pagination"
import { billingService } from "./billing.service"

export const billingController = {
	async summary(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(await billingService.getSummary(membership.organizationId))
	},

	async transactions(c: AppContext) {
		const membership = requireMembership(c)
		const query = paginationQuerySchema.parse(c.req.query())
		return c.json(await billingService.listTransactions(membership.organizationId, query))
	},
}
