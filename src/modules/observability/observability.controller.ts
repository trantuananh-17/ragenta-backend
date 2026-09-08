import type { AppContext } from "../../api/types"
import { requireMembership } from "../../api/types"
import { platformUsageQuerySchema } from "../usage/platform-usage.dto"
import { errorLogService } from "./error-log.service"

export const observabilityController = {
	/** The platform view: what has been failing, and how often. */
	async listPlatformErrors(c: AppContext) {
		const { from, to } = platformUsageQuerySchema.parse(c.req.query())
		const [errors, summary] = await Promise.all([
			errorLogService.listRecent(from, to, 200),
			errorLogService.summarise(from, to),
		])
		return c.json({ range: { from: from.toISOString(), to: to.toISOString() }, errors, summary })
	},

	/**
	 * One workspace's own failures.
	 *
	 * A customer whose agent stopped working should be able to see the provider's
	 * refusal without asking somebody to read a log for them — and it is their own
	 * data, scoped by the membership like everything else.
	 */
	async listWorkspaceErrors(c: AppContext) {
		const membership = requireMembership(c)
		const errors = await errorLogService.listForWorkspace(membership.organizationId, 100)
		return c.json({ errors })
	},
}
