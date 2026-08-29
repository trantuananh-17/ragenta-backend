import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { auditService } from "../audit/audit.service"
import { projectRepository } from "./project.repository"
import type { CreateProjectInput, UpdateProjectInput } from "./project.dto"

function slugify(value: string) {
	return value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
}

async function availableSlug(workspaceId: string, preferred: string) {
	const base = slugify(preferred) || "project"
	for (let attempt = 0; attempt < 5; attempt++) {
		const candidate = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`
		const existing = await projectRepository.findBySlug(workspaceId, candidate)
		if (!existing) return candidate
	}
	throw new ConflictError("Could not derive a free project slug. Provide one explicitly.")
}

export const projectService = {
	async list(workspaceId: string, includeArchived: boolean) {
		return projectRepository.list(workspaceId, includeArchived)
	},

	async get(workspaceId: string, projectId: string) {
		const found = await projectRepository.findById(workspaceId, projectId)
		if (!found) throw new NotFoundError("Project")
		return found
	},

	async create(workspaceId: string, input: CreateProjectInput, actorId: string) {
		if (input.slug && (await projectRepository.findBySlug(workspaceId, input.slug))) {
			throw new ConflictError("A project with that URL already exists in this workspace.")
		}

		const slug = input.slug ?? (await availableSlug(workspaceId, input.name))

		const created = await projectRepository.insert({
			id: newId(),
			organizationId: workspaceId,
			name: input.name,
			slug,
			description: input.description ?? null,
			createdBy: actorId,
		})
		if (!created) throw new ConflictError("Project could not be created.")

		await auditService.record({
			action: "project.created",
			actorId,
			organizationId: workspaceId,
			targetType: "project",
			targetId: created.id,
			metadata: { name: created.name, slug },
		})

		return created
	},

	async update(
		workspaceId: string,
		projectId: string,
		input: UpdateProjectInput,
		actorId: string,
	) {
		const current = await this.get(workspaceId, projectId)
		if (current.archivedAt) {
			throw new ValidationError("Restore the project before editing it.")
		}

		const updated = await projectRepository.update(workspaceId, projectId, {
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.description !== undefined ? { description: input.description } : {}),
		})
		if (!updated) throw new NotFoundError("Project")

		await auditService.record({
			action: "project.updated",
			actorId,
			organizationId: workspaceId,
			targetType: "project",
			targetId: projectId,
			metadata: { fields: Object.keys(input) },
		})

		return updated
	},

	/**
	 * Archiving keeps the project and its usage history readable and reversible.
	 * It is what "delete" should mean for anything that credits were spent on.
	 */
	async archive(workspaceId: string, projectId: string, actorId: string) {
		const current = await this.get(workspaceId, projectId)
		if (current.archivedAt) return current

		const updated = await projectRepository.update(workspaceId, projectId, {
			archivedAt: new Date(),
		})

		await auditService.record({
			action: "project.archived",
			actorId,
			organizationId: workspaceId,
			targetType: "project",
			targetId: projectId,
		})

		return updated
	},

	async restore(workspaceId: string, projectId: string, actorId: string) {
		await this.get(workspaceId, projectId)

		const updated = await projectRepository.update(workspaceId, projectId, {
			archivedAt: null,
		})

		await auditService.record({
			action: "project.restored",
			actorId,
			organizationId: workspaceId,
			targetType: "project",
			targetId: projectId,
		})

		return updated
	},

	/**
	 * Permanent. Usage rows survive with `project_id` set to null, so the
	 * workspace's billing history stays complete and reconcilable even though the
	 * attribution is gone.
	 */
	async remove(workspaceId: string, projectId: string, actorId: string) {
		const current = await this.get(workspaceId, projectId)
		if (!current.archivedAt) {
			throw new ValidationError("Archive the project before deleting it permanently.")
		}

		await projectRepository.remove(workspaceId, projectId)

		await auditService.record({
			action: "project.deleted",
			actorId,
			organizationId: workspaceId,
			targetType: "project",
			targetId: projectId,
			metadata: { name: current.name, slug: current.slug },
		})
	},
}
