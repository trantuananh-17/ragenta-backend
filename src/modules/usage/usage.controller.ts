import { z } from "zod"

import type { AppContext } from "../../api/types"
import { requireMembership } from "../../api/types"
import { paginationQuerySchema } from "../../shared/pagination"
import { platformUsageQuerySchema, platformUsageService } from "./platform-usage.service"
import { usageService } from "./usage.service"

const usageQuerySchema = z.object({
	projectId: z.string().min(1).optional(),
	operation: z.enum(["chat", "embedding", "rerank", "ingestion", "agent"]).optional(),
})

const summaryQuerySchema = z.object({
	days: z.coerce.number().int().min(1).max(90).default(30),
})

export const usageController = {
	async list(c: AppContext) {
		const membership = requireMembership(c)
		const query = paginationQuerySchema.parse(c.req.query())
		const filter = usageQuerySchema.parse(c.req.query())
		return c.json(await usageService.list(membership.organizationId, filter, query))
	},

	async summary(c: AppContext) {
		const membership = requireMembership(c)
		const { days } = summaryQuerySchema.parse(c.req.query())
		return c.json(await usageService.summary(membership.organizationId, days))
	},
}

/**
 * The platform view — every workspace at once, which is why these sit behind
 * `admin.usage.read` and take no membership (ADR-051).
 */
export const platformUsageController = {
	async overview(c: AppContext) {
		const query = platformUsageQuerySchema.parse(c.req.query())
		return c.json(await platformUsageService.overview(query))
	},

	async byModel(c: AppContext) {
		const query = platformUsageQuerySchema.parse(c.req.query())
		return c.json(await platformUsageService.byModel(query))
	},

	async byWorkspace(c: AppContext) {
		const query = platformUsageQuerySchema.parse(c.req.query())
		return c.json(await platformUsageService.byWorkspace(query))
	},
}
