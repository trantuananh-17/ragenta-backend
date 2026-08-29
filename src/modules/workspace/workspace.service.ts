import { auth } from "../../auth/auth"
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors"
import { logger } from "../../shared/logger"
import type { PaginationQuery } from "../../shared/pagination"
import { page } from "../../shared/pagination"
import { auditService } from "../audit/audit.service"
import { billingService } from "../billing/billing.service"
import { workspaceRepository } from "./workspace.repository"
import type {
	CreateWorkspaceInput,
	InviteMemberInput,
	UpdateMemberRoleInput,
	UpdateWorkspaceInput,
} from "./workspace.dto"

const log = logger.child({ module: "workspace" })

function slugify(value: string) {
	return value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
}

async function availableSlug(preferred: string): Promise<string> {
	const base = slugify(preferred) || "workspace"
	for (let attempt = 0; attempt < 5; attempt++) {
		const candidate = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`
		const existing = await workspaceRepository.findBySlug(candidate)
		if (!existing) return candidate
	}
	throw new ConflictError("Could not derive a free workspace slug. Provide one explicitly.")
}

/**
 * Membership operations are delegated to Better Auth's organization API rather
 * than written directly: it owns the invitation lifecycle, role validation and
 * the active-workspace bookkeeping on the session. What this service adds is the
 * Ragenta layer around it — provisioning, entitlement, ownership guards and the
 * audit trail.
 *
 * `headers` is the caller's real request headers. Better Auth resolves the actor
 * from them, so a caller can never act as somebody else by naming an id.
 */
export const workspaceService = {
	async listForUser(userId: string) {
		return workspaceRepository.listForUser(userId)
	},

	async create(input: CreateWorkspaceInput, actorId: string, headers: Headers) {
		const slug = input.slug ?? (await availableSlug(input.name))

		if (input.slug && (await workspaceRepository.findBySlug(input.slug))) {
			throw new ConflictError("That workspace URL is already taken.")
		}

		const created = await auth.api.createOrganization({
			body: { name: input.name, slug },
			headers,
		})
		if (!created) throw new ConflictError("Workspace could not be created.")

		// Provisioning is separate from creation on purpose: it is idempotent and
		// can be re-run for a workspace whose billing rows are missing.
		await billingService.provisionWorkspace(created.id)

		await auditService.record({
			action: "workspace.created",
			actorId,
			organizationId: created.id,
			targetType: "workspace",
			targetId: created.id,
			metadata: { name: created.name, slug },
		})

		log.info("workspace.created", { workspaceId: created.id })
		return created
	},

	async getOverview(workspaceId: string) {
		const workspace = await workspaceRepository.findById(workspaceId)
		if (!workspace) throw new NotFoundError("Workspace")

		const billing = await billingService.getSummary(workspaceId)
		return { workspace, billing }
	},

	async update(
		workspaceId: string,
		input: UpdateWorkspaceInput,
		actorId: string,
	) {
		const updated = await workspaceRepository.update(workspaceId, {
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.logo !== undefined ? { logo: input.logo } : {}),
		})
		if (!updated) throw new NotFoundError("Workspace")

		await auditService.record({
			action: "workspace.updated",
			actorId,
			organizationId: workspaceId,
			targetType: "workspace",
			targetId: workspaceId,
			metadata: { fields: Object.keys(input) },
		})

		return updated
	},

	async listMembers(workspaceId: string, query: PaginationQuery) {
		const { items, total } = await workspaceRepository.listMembers(workspaceId, query)
		return page(items, total, query)
	},

	async listInvitations(workspaceId: string) {
		return workspaceRepository.listInvitations(workspaceId)
	},

	async invite(
		workspaceId: string,
		input: InviteMemberInput,
		actorId: string,
		headers: Headers,
	) {
		// The seat cap also runs inside Better Auth's beforeCreateInvitation hook.
		// Checking here too keeps the refusal a plain domain error for callers that
		// reach the service directly (jobs, admin tooling).
		await billingService.assertSeatAvailable(workspaceId)

		const invitation = await auth.api.createInvitation({
			body: { email: input.email, role: input.role, organizationId: workspaceId },
			headers,
		})

		await auditService.record({
			action: "workspace.member.invited",
			actorId,
			organizationId: workspaceId,
			targetType: "invitation",
			targetId: invitation.id,
			metadata: { email: input.email, role: input.role },
		})

		return invitation
	},

	async cancelInvitation(
		workspaceId: string,
		invitationId: string,
		actorId: string,
		headers: Headers,
	) {
		const result = await auth.api.cancelInvitation({
			body: { invitationId },
			headers,
		})

		await auditService.record({
			action: "workspace.member.invitation_cancelled",
			actorId,
			organizationId: workspaceId,
			targetType: "invitation",
			targetId: invitationId,
		})

		return result
	},

	async updateMemberRole(
		workspaceId: string,
		memberId: string,
		input: UpdateMemberRoleInput,
		actorId: string,
		headers: Headers,
	) {
		const target = await workspaceRepository.findMemberById(workspaceId, memberId)
		if (!target) throw new NotFoundError("Member")

		await assertNotLastOwner(workspaceId, target.role)

		const result = await auth.api.updateMemberRole({
			body: { memberId, role: input.role, organizationId: workspaceId },
			headers,
		})

		await auditService.record({
			action: "workspace.member.role_changed",
			actorId,
			organizationId: workspaceId,
			targetType: "member",
			targetId: memberId,
			metadata: { from: target.role, to: input.role, userId: target.userId },
		})

		return result
	},

	async removeMember(
		workspaceId: string,
		memberId: string,
		actorId: string,
		headers: Headers,
	) {
		const target = await workspaceRepository.findMemberById(workspaceId, memberId)
		if (!target) throw new NotFoundError("Member")

		await assertNotLastOwner(workspaceId, target.role)

		const result = await auth.api.removeMember({
			body: { memberIdOrEmail: memberId, organizationId: workspaceId },
			headers,
		})

		await auditService.record({
			action: "workspace.member.removed",
			actorId,
			organizationId: workspaceId,
			targetType: "member",
			targetId: memberId,
			metadata: { userId: target.userId, role: target.role },
		})

		return result
	},
}

/**
 * A workspace without an owner cannot be administered or billed, and nothing in
 * the API can restore one — so the last owner may not be demoted or removed.
 */
async function assertNotLastOwner(workspaceId: string, currentRole: string) {
	if (currentRole !== "owner") return
	const owners = await workspaceRepository.countMembersWithRole(workspaceId, "owner")
	if (owners <= 1) {
		throw new ValidationError(
			"This is the only owner of the workspace. Promote another member to owner first.",
		)
	}
}
