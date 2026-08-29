import type { AppContext } from "../../api/types"
import { requireParam, requireUser } from "../../api/types"
import { ValidationError } from "../../shared/errors"
import { paginationQuerySchema } from "../../shared/pagination"
import { isPlanName } from "../billing/plans"
import { adjustCreditsSchema, adminListQuerySchema, setPlanSchema } from "./admin.dto"
import { adminService } from "./admin.service"

export const adminController = {
	async listUsers(c: AppContext) {
		const query = paginationQuerySchema.parse(c.req.query())
		const { search } = adminListQuerySchema.parse(c.req.query())
		return c.json(await adminService.listUsers(search, query))
	},

	async listWorkspaces(c: AppContext) {
		const query = paginationQuerySchema.parse(c.req.query())
		const { search } = adminListQuerySchema.parse(c.req.query())
		return c.json(await adminService.listWorkspaces(search, query))
	},

	async getWorkspace(c: AppContext) {
		return c.json(await adminService.getWorkspace(requireParam(c, "workspaceId")))
	},

	async adjustCredits(c: AppContext) {
		const actor = requireUser(c)
		const input = adjustCreditsSchema.parse(await c.req.json())
		const result = await adminService.adjustCredits(
			requireParam(c, "workspaceId"),
			input,
			actor.id,
		)
		return c.json(result)
	},

	async setPlan(c: AppContext) {
		const actor = requireUser(c)
		const { plan } = setPlanSchema.parse(await c.req.json())
		if (!isPlanName(plan)) throw new ValidationError(`Unknown plan: ${plan}`)
		const subscription = await adminService.setPlan(
			requireParam(c, "workspaceId"),
			plan,
			actor.id,
		)
		return c.json({ subscription })
	},

	async listAuditLog(c: AppContext) {
		const query = paginationQuerySchema.parse(c.req.query())
		const { workspaceId, actorId, action } = c.req.query()
		return c.json(
			await adminService.listAuditLog({ organizationId: workspaceId, actorId, action }, query),
		)
	},
}
