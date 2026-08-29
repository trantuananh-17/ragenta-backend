import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import {
	createProjectSchema,
	listProjectsQuerySchema,
	updateProjectSchema,
} from "./project.dto"
import { projectService } from "./project.service"

export const projectController = {
	async list(c: AppContext) {
		const membership = requireMembership(c)
		const { includeArchived } = listProjectsQuerySchema.parse(c.req.query())
		return c.json({
			projects: await projectService.list(membership.organizationId, includeArchived),
		})
	},

	async create(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = createProjectSchema.parse(await c.req.json())
		const project = await projectService.create(membership.organizationId, input, user.id)
		return c.json({ project }, 201)
	},

	async get(c: AppContext) {
		const membership = requireMembership(c)
		const project = await projectService.get(
			membership.organizationId,
			requireParam(c, "projectId"),
		)
		return c.json({ project })
	},

	async update(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = updateProjectSchema.parse(await c.req.json())
		const project = await projectService.update(
			membership.organizationId,
			requireParam(c, "projectId"),
			input,
			user.id,
		)
		return c.json({ project })
	},

	async archive(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const project = await projectService.archive(
			membership.organizationId,
			requireParam(c, "projectId"),
			user.id,
		)
		return c.json({ project })
	},

	async restore(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const project = await projectService.restore(
			membership.organizationId,
			requireParam(c, "projectId"),
			user.id,
		)
		return c.json({ project })
	},

	async remove(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		await projectService.remove(
			membership.organizationId,
			requireParam(c, "projectId"),
			user.id,
		)
		return c.body(null, 204)
	},
}
