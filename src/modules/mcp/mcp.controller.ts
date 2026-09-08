import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import { saveMcpServerSchema } from "./mcp.dto"
import { mcpService } from "./mcp.service"

export const mcpController = {
	/** Platform-wide servers plus this workspace's own — what its agents can reach. */
	async listForWorkspace(c: AppContext) {
		const membership = requireMembership(c)
		return c.json({ servers: await mcpService.listForWorkspace(membership.organizationId) })
	},

	async listTools(c: AppContext) {
		const membership = requireMembership(c)
		return c.json({ tools: await mcpService.listAvailableTools(membership.organizationId) })
	},

	async saveForWorkspace(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = saveMcpServerSchema.parse(await c.req.json())
		const server = await mcpService.save(membership.organizationId, input, user.id)
		return c.json({ server })
	},

	async removeForWorkspace(c: AppContext) {
		const membership = requireMembership(c)
		await mcpService.removeScoped(membership.organizationId, requireParam(c, "serverId"))
		return c.body(null, 204)
	},

	async checkForWorkspace(c: AppContext) {
		const membership = requireMembership(c)
		const server = await mcpService.checkScoped(
			membership.organizationId,
			requireParam(c, "serverId"),
		)
		return c.json({ server })
	},

	async listPlatform(c: AppContext) {
		return c.json({ servers: await mcpService.listPlatform() })
	},

	async savePlatform(c: AppContext) {
		const user = requireUser(c)
		const input = saveMcpServerSchema.parse(await c.req.json())
		return c.json({ server: await mcpService.save(null, input, user.id) })
	},

	async removePlatform(c: AppContext) {
		await mcpService.removePlatform(requireParam(c, "serverId"))
		return c.body(null, 204)
	},

	async checkPlatform(c: AppContext) {
		return c.json({ server: await mcpService.checkPlatform(requireParam(c, "serverId")) })
	},
}
