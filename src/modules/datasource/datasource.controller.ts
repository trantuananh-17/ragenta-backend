import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import {
	dryRunSchema,
	generateQuerySchema,
	saveDataSourceSchema,
	saveQuerySchema,
} from "./datasource.dto"
import { datasourceService } from "./datasource.service"

export const datasourceController = {
	async list(c: AppContext) {
		const membership = requireMembership(c)
		return c.json({ sources: await datasourceService.list(membership.organizationId) })
	},

	async saveSource(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = saveDataSourceSchema.parse(await c.req.json())
		const source = await datasourceService.saveSource(membership.organizationId, input, user.id)
		return c.json({ source })
	},

	async refreshSchema(c: AppContext) {
		const membership = requireMembership(c)
		const tables = await datasourceService.refreshSchema(
			membership.organizationId,
			requireParam(c, "sourceId"),
		)
		return c.json({ tables })
	},

	async removeSource(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		await datasourceService.removeSource(
			membership.organizationId,
			requireParam(c, "sourceId"),
			user.id,
		)
		return c.body(null, 204)
	},

	/**
	 * Proposes a query from a description. Nothing is saved and no agent can call
	 * it — the screen shows the SQL, runs it, and a person decides.
	 */
	async generateQuery(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = generateQuerySchema.parse(await c.req.json())
		const result = await datasourceService.generateQuery(
			membership.organizationId,
			input,
			user.id,
		)
		return c.json(result)
	},

	/** Runs a statement once, so somebody can see what it returns before approving. */
	async dryRun(c: AppContext) {
		const membership = requireMembership(c)
		const input = dryRunSchema.parse(await c.req.json())
		const outcome = await datasourceService.dryRun(
			membership.organizationId,
			input.dataSourceId,
			input.sql,
			input.parameters,
			input.rowLimit,
		)
		return c.json(outcome)
	},

	async saveQuery(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = saveQuerySchema.parse(await c.req.json())
		const query = await datasourceService.saveQuery(membership.organizationId, input, user.id)
		return c.json({ query })
	},

	async removeQuery(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		await datasourceService.removeQuery(
			membership.organizationId,
			requireParam(c, "queryId"),
			user.id,
		)
		return c.body(null, 204)
	},
}
