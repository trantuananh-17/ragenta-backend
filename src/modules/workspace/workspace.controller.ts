import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import { paginationQuerySchema } from "../../shared/pagination"
import {
	createWorkspaceSchema,
	inviteMemberSchema,
	updateMemberRoleSchema,
	updateWorkspaceSchema,
} from "./workspace.dto"
import { workspaceService } from "./workspace.service"

/**
 * Controllers do three things and nothing else: validate the request, call one
 * service method, shape the response. No queries, no rules, no branching on
 * roles — that is the middleware's and the service's job.
 */
export const workspaceController = {
	async list(c: AppContext) {
		const user = requireUser(c)
		return c.json({ workspaces: await workspaceService.listForUser(user.id) })
	},

	async create(c: AppContext) {
		const user = requireUser(c)
		const input = createWorkspaceSchema.parse(await c.req.json())
		const workspace = await workspaceService.create(input, user.id, c.req.raw.headers)
		return c.json({ workspace }, 201)
	},

	async get(c: AppContext) {
		const membership = requireMembership(c)
		const overview = await workspaceService.getOverview(membership.organizationId)
		return c.json({ ...overview, role: membership.role })
	},

	async update(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = updateWorkspaceSchema.parse(await c.req.json())
		const workspace = await workspaceService.update(
			membership.organizationId,
			input,
			user.id,
		)
		return c.json({ workspace })
	},

	async listMembers(c: AppContext) {
		const membership = requireMembership(c)
		const query = paginationQuerySchema.parse(c.req.query())
		return c.json(await workspaceService.listMembers(membership.organizationId, query))
	},

	async listInvitations(c: AppContext) {
		const membership = requireMembership(c)
		return c.json({
			invitations: await workspaceService.listInvitations(membership.organizationId),
		})
	},

	async invite(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = inviteMemberSchema.parse(await c.req.json())
		const invitation = await workspaceService.invite(
			membership.organizationId,
			input,
			user.id,
			c.req.raw.headers,
		)
		return c.json({ invitation }, 201)
	},

	async cancelInvitation(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		await workspaceService.cancelInvitation(
			membership.organizationId,
			requireParam(c, "invitationId"),
			user.id,
			c.req.raw.headers,
		)
		return c.body(null, 204)
	},

	async updateMemberRole(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = updateMemberRoleSchema.parse(await c.req.json())
		const result = await workspaceService.updateMemberRole(
			membership.organizationId,
			requireParam(c, "memberId"),
			input,
			user.id,
			c.req.raw.headers,
		)
		return c.json({ member: result })
	},

	async removeMember(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		await workspaceService.removeMember(
			membership.organizationId,
			requireParam(c, "memberId"),
			user.id,
			c.req.raw.headers,
		)
		return c.body(null, 204)
	},
}
