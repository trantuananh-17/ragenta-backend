import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import {
	createRoleSchema,
	createWorkspaceRoleSchema,
	listRolesQuerySchema,
	setRolesSchema,
	updateRoleSchema,
} from "./rbac.dto"
import { rbacService } from "./rbac.service"

export const rbacController = {
	listPermissions(c: AppContext) {
		return c.json({ permissions: rbacService.listPermissions() })
	},

	async listRoles(c: AppContext) {
		const { workspaceId } = listRolesQuerySchema.parse(c.req.query())
		return c.json({ roles: await rbacService.listRoles(workspaceId) })
	},

	async getRole(c: AppContext) {
		return c.json({ role: await rbacService.getRole(requireParam(c, "roleId")) })
	},

	async createRole(c: AppContext) {
		const actor = requireUser(c)
		const input = createRoleSchema.parse(await c.req.json())
		return c.json({ role: await rbacService.createRole(input, actor) }, 201)
	},

	async updateRole(c: AppContext) {
		const actor = requireUser(c)
		const input = updateRoleSchema.parse(await c.req.json())
		const role = await rbacService.updateRole(requireParam(c, "roleId"), input, actor)
		return c.json({ role })
	},

	async deleteRole(c: AppContext) {
		const actor = requireUser(c)
		await rbacService.deleteRole(requireParam(c, "roleId"), actor)
		return c.body(null, 204)
	},

	async listPlatformRoles(c: AppContext) {
		return c.json({ roles: await rbacService.listPlatformRoles(requireParam(c, "userId")) })
	},

	async setPlatformRoles(c: AppContext) {
		const actor = requireUser(c)
		const input = setRolesSchema.parse(await c.req.json())
		const roles = await rbacService.setPlatformRoles(requireParam(c, "userId"), input.roleIds, actor)
		return c.json({ roles })
	},

	async listMemberRoles(c: AppContext) {
		const roles = await rbacService.listMemberRoles(
			requireParam(c, "workspaceId"),
			requireParam(c, "memberId"),
		)
		return c.json({ roles })
	},

	async setMemberRoles(c: AppContext) {
		const actor = requireUser(c)
		const input = setRolesSchema.parse(await c.req.json())
		const roles = await rbacService.setMemberRoles(
			requireParam(c, "workspaceId"),
			requireParam(c, "memberId"),
			input.roleIds,
			actor,
		)
		return c.json({ roles })
	},

	async listWorkspaceRoles(c: AppContext) {
		const membership = requireMembership(c)
		return c.json({ roles: await rbacService.listWorkspaceRoles(membership.organizationId) })
	},

	async createWorkspaceRole(c: AppContext) {
		const actor = requireUser(c)
		const membership = requireMembership(c)
		const input = createWorkspaceRoleSchema.parse(await c.req.json())
		const role = await rbacService.createWorkspaceRole(
			membership.organizationId,
			membership,
			input,
			actor,
		)
		return c.json({ role }, 201)
	},

	async updateWorkspaceRole(c: AppContext) {
		const actor = requireUser(c)
		const membership = requireMembership(c)
		const input = updateRoleSchema.parse(await c.req.json())
		const role = await rbacService.updateWorkspaceRole(
			membership.organizationId,
			membership,
			requireParam(c, "roleId"),
			input,
			actor,
		)
		return c.json({ role })
	},

	async deleteWorkspaceRole(c: AppContext) {
		const actor = requireUser(c)
		const membership = requireMembership(c)
		await rbacService.deleteWorkspaceRole(
			membership.organizationId,
			requireParam(c, "roleId"),
			actor,
		)
		return c.body(null, 204)
	},

	async listWorkspaceMemberRoles(c: AppContext) {
		const membership = requireMembership(c)
		const roles = await rbacService.listMemberRoles(
			membership.organizationId,
			requireParam(c, "memberId"),
		)
		return c.json({ roles })
	},

	async setWorkspaceMemberRoles(c: AppContext) {
		const actor = requireUser(c)
		const membership = requireMembership(c)
		const input = setRolesSchema.parse(await c.req.json())
		const roles = await rbacService.setMemberRoles(
			membership.organizationId,
			requireParam(c, "memberId"),
			input.roleIds,
			actor,
		)
		return c.json({ roles })
	},
}
