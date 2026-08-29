import { NotFoundError } from "../../shared/errors"
import { newId } from "../../shared/id"
import type { PaginationQuery } from "../../shared/pagination"
import { page } from "../../shared/pagination"
import { auditService } from "../audit/audit.service"
import { billingService } from "../billing/billing.service"
import type { PlanName } from "../billing/plans"
import { workspaceRepository } from "../workspace/workspace.repository"
import { adminRepository } from "./admin.repository"
import type { AdjustCreditsInput } from "./admin.dto"

export const adminService = {
	async listUsers(search: string | undefined, query: PaginationQuery) {
		const { items, total } = await adminRepository.listUsers(search, query)
		return page(items, total, query)
	},

	async listWorkspaces(search: string | undefined, query: PaginationQuery) {
		const { items, total } = await adminRepository.listWorkspaces(search, query)
		return page(items, total, query)
	},

	async getWorkspace(workspaceId: string) {
		const workspace = await workspaceRepository.findById(workspaceId)
		if (!workspace) throw new NotFoundError("Workspace")

		const [billing, members] = await Promise.all([
			billingService.getSummary(workspaceId),
			adminRepository.countWorkspaceMembers(workspaceId),
		])

		return { workspace, billing, members }
	},

	/**
	 * Manual credit movement. Both directions go through the normal ledger paths
	 * so an adjustment is indistinguishable from any other movement when the
	 * balance is reconciled — there is no back door that writes the balance
	 * without a matching row.
	 */
	async adjustCredits(workspaceId: string, input: AdjustCreditsInput, actorId: string) {
		const workspace = await workspaceRepository.findById(workspaceId)
		if (!workspace) throw new NotFoundError("Workspace")

		const reference = `admin:${input.idempotencyKey ?? newId()}`

		if (input.amount > 0) {
			return billingService.grant({
				workspaceId,
				amount: input.amount,
				bucket: input.bucket,
				kind: "admin_adjust",
				reference,
				actorId,
				reason: input.reason,
			})
		}

		const result = await billingService.spend({
			workspaceId,
			amount: Math.abs(input.amount),
			reference,
			source: "admin",
		})

		await auditService.record({
			action: "billing.credits.reduced",
			actorId,
			organizationId: workspaceId,
			targetType: "credit_balance",
			targetId: workspaceId,
			metadata: { amount: input.amount, reason: input.reason, reference },
		})

		return result
	},

	async setPlan(workspaceId: string, plan: PlanName, actorId: string) {
		return billingService.changePlan(workspaceId, plan, actorId)
	},

	async listAuditLog(
		filter: { organizationId?: string; actorId?: string; action?: string },
		query: PaginationQuery,
	) {
		return auditService.list(filter, query)
	},
}
