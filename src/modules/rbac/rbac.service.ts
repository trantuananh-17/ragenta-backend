import { PERMISSIONS, findPermission } from "../../auth/permissions"
import type { AuthUser } from "../../auth/auth"
import { env } from "../../config/env"
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import { auditService } from "../audit/audit.service"
import type { MembershipRow } from "../workspace/workspace.repository"
import { workspaceRepository } from "../workspace/workspace.repository"
import { isBreakGlassAdmin } from "./break-glass"
import { permissionService } from "./permission.service"
import { rbacRepository } from "./rbac.repository"
import type { CreateRoleInput, CreateWorkspaceRoleInput, UpdateRoleInput } from "./rbac.dto"

const log = logger.child({ module: "rbac" })

/**
 * Composing roles, and handing them out.
 *
 * The rule that governs the whole file: **nobody may grant a permission they do
 * not themselves hold.** Without it, an administrator with `admin.role.manage`
 * and nothing else could write themselves a role carrying `admin.credit.adjust`
 * and assign it to themselves — which makes every other permission decorative.
 * A break-glass administrator holds everything, so the check passes for them by
 * being true rather than by being skipped.
 */
async function assertMayGrant(actor: AuthUser, keys: readonly string[]): Promise<void> {
	if (isBreakGlassAdmin(actor, env.adminUserIds)) return

	const platformHeld = await permissionService.forPlatformUser(actor.id)
	const missing = keys.filter((key) => {
		const entry = findPermission(key)
		if (!entry) return true
		// A workspace permission is not something a platform administrator holds
		// personally, so requiring that would make workspace roles uncomposable.
		// The gate on those is `admin.role.manage` plus the workspace scope; the
		// escalation this guards against is a *platform* one.
		return entry.scope === "platform" && !platformHeld.has(key)
	})

	if (missing.length > 0) {
		throw new ForbiddenError(
			`You cannot grant a permission you do not hold: ${missing.join(", ")}.`,
		)
	}
}

function assertScopeIsCoherent(scope: string, organizationId: string | undefined): void {
	if (scope === "platform" && organizationId) {
		throw new ValidationError("A platform role cannot belong to a workspace.")
	}
}

async function assertPermissionsMatchScope(scope: string, keys: readonly string[]): Promise<void> {
	const wrong = keys.filter((key) => findPermission(key)?.scope !== scope)
	if (wrong.length > 0) {
		throw new ValidationError(
			`These permissions are not ${scope}-scoped: ${wrong.join(", ")}.`,
		)
	}
}

export const rbacService = {
	listPermissions() {
		return PERMISSIONS.map((entry) => ({
			key: entry.key,
			scope: entry.scope,
			resource: entry.resource,
			action: entry.action,
			description: entry.description,
			grantableOn: entry.grantableOn ?? null,
		}))
	},

	async listRoles(workspaceId: string | undefined) {
		const roles = await rbacRepository.listRoles(workspaceId)
		return Promise.all(
			roles.map(async (role) => ({
				...role,
				permissions: await rbacRepository.listRolePermissionKeys(role.id),
			})),
		)
	},

	async getRole(roleId: string) {
		const role = await rbacRepository.findRoleById(roleId)
		if (!role) throw new NotFoundError("Role")
		return { ...role, permissions: await rbacRepository.listRolePermissionKeys(roleId) }
	},

	async createRole(input: CreateRoleInput, actor: AuthUser) {
		assertScopeIsCoherent(input.scope, input.organizationId)
		await assertPermissionsMatchScope(input.scope, input.permissions)
		await assertMayGrant(actor, input.permissions)

		if (input.organizationId) {
			const workspace = await workspaceRepository.findById(input.organizationId)
			if (!workspace) throw new NotFoundError("Workspace")
		}

		const existing = await rbacRepository.listRoles(input.organizationId)
		if (existing.some((role) => role.key === input.key && role.scope === input.scope)) {
			throw new ConflictError("A role with that key already exists here.")
		}

		const id = newId()
		await rbacRepository.createRole(
			{
				id,
				organizationId: input.organizationId ?? null,
				scope: input.scope,
				key: input.key,
				name: input.name,
				description: input.description,
				isSystem: false,
				createdBy: actor.id,
			},
			input.permissions,
		)

		await auditService.record({
			action: "rbac.role.created",
			actorId: actor.id,
			organizationId: input.organizationId ?? null,
			targetType: "role",
			targetId: id,
			metadata: { key: input.key, scope: input.scope, permissions: input.permissions },
		})

		log.info("rbac.role.created", { roleId: id, key: input.key })
		return rbacService.getRole(id)
	},

	/**
	 * A system role's name and description are editable; its permission set is
	 * not. The seeder reconciles that set to the catalogue on every deploy, so an
	 * edit would be silently reverted — refusing it is the honest answer.
	 */
	async updateRole(roleId: string, input: UpdateRoleInput, actor: AuthUser) {
		const role = await rbacRepository.findRoleById(roleId)
		if (!role) throw new NotFoundError("Role")

		if (input.permissions) {
			if (role.isSystem) {
				throw new ForbiddenError(
					"A built-in role's permissions are defined in the release and reset on every deploy. Create a role instead.",
				)
			}
			await assertPermissionsMatchScope(role.scope, input.permissions)
			await assertMayGrant(actor, input.permissions)
		}

		await rbacRepository.updateRole(
			roleId,
			{
				...(input.name === undefined ? {} : { name: input.name }),
				...(input.description === undefined ? {} : { description: input.description }),
			},
			input.permissions,
		)

		// Editing a role changes what an unknown set of people may do; see ADR-047
		// for why this flushes everything rather than finding them.
		if (input.permissions) await permissionService.invalidateAll()

		await auditService.record({
			action: "rbac.role.updated",
			actorId: actor.id,
			organizationId: role.organizationId,
			targetType: "role",
			targetId: roleId,
			metadata: { permissions: input.permissions ?? null },
		})

		return rbacService.getRole(roleId)
	},

	async deleteRole(roleId: string, actor: AuthUser) {
		const role = await rbacRepository.findRoleById(roleId)
		if (!role) throw new NotFoundError("Role")
		if (role.isSystem) throw new ForbiddenError("A built-in role cannot be deleted.")

		const holders = await rbacRepository.countRoleHolders(roleId)
		if (holders > 0) {
			throw new ConflictError(
				`${holders} ${holders === 1 ? "person holds" : "people hold"} this role. Reassign them first.`,
			)
		}

		await rbacRepository.deleteRole(roleId)
		await permissionService.invalidateAll()

		await auditService.record({
			action: "rbac.role.deleted",
			actorId: actor.id,
			organizationId: role.organizationId,
			targetType: "role",
			targetId: roleId,
			metadata: { key: role.key, scope: role.scope },
		})
	},

	async listPlatformRoles(userId: string) {
		return rbacRepository.listPlatformRoles(userId)
	},

	/**
	 * Replaces somebody's platform roles.
	 *
	 * The last `superadmin` cannot be taken away — not because that person is
	 * special, but because a console nobody can administer is recoverable only by
	 * editing the VM's environment, and an operator who does not know that is
	 * locked out of their own product.
	 */
	async setPlatformRoles(userId: string, roleIds: string[], actor: AuthUser) {
		const roles = await Promise.all(roleIds.map((id) => rbacRepository.findRoleById(id)))

		const resolved = roles.map((role, index) => {
			if (!role) throw new NotFoundError("Role")
			if (role.scope !== "platform") {
				throw new ValidationError(`${roleIds[index]} is not a platform role.`)
			}
			return role
		})

		const granted = (
			await Promise.all(resolved.map((role) => rbacRepository.listRolePermissionKeys(role.id)))
		).flat()
		await assertMayGrant(actor, granted)

		await rbacService.assertNotLastSuperadmin(userId, resolved.map((role) => role.key))

		await rbacRepository.replacePlatformRoles(userId, roleIds, actor.id)
		await permissionService.invalidatePlatformUser(userId)

		await auditService.record({
			action: "rbac.platform_roles.set",
			actorId: actor.id,
			targetType: "user",
			targetId: userId,
			metadata: { roles: resolved.map((role) => role.key) },
		})

		return rbacRepository.listPlatformRoles(userId)
	},

	async assertNotLastSuperadmin(userId: string, incomingKeys: string[]): Promise<void> {
		if (incomingKeys.includes("superadmin")) return

		const held = await rbacRepository.listPlatformRoles(userId)
		if (!held.some((role) => role.key === "superadmin")) return

		const superadmin = held.find((role) => role.key === "superadmin")
		if (!superadmin) return

		const holders = await rbacRepository.countPlatformRoleHolders(superadmin.id)
		if (holders <= 1) {
			throw new ConflictError(
				"This is the only super administrator. Grant the role to somebody else first.",
			)
		}
	},

	async listMemberRoles(workspaceId: string, memberId: string) {
		const membership = await workspaceRepository.findMemberById(workspaceId, memberId)
		if (!membership) throw new NotFoundError("Member")
		return rbacRepository.listMemberRoles(memberId)
	},

	/**
	 * Replaces a membership's roles.
	 *
	 * `member.role` is left alone: Better Auth owns it and resolves its own
	 * membership endpoints through it, so writing it from here would mean two
	 * writers and no agreement about which won. What changes is what Ragenta
	 * checks, which is this table (ADR-046).
	 */
	async setMemberRoles(workspaceId: string, memberId: string, roleIds: string[], actor: AuthUser) {
		const membership = await workspaceRepository.findMemberById(workspaceId, memberId)
		if (!membership) throw new NotFoundError("Member")

		const roles = await Promise.all(roleIds.map((id) => rbacRepository.findRoleById(id)))
		const resolved = roles.map((role, index) => {
			if (!role) throw new NotFoundError("Role")
			if (role.scope !== "workspace") {
				throw new ValidationError(`${roleIds[index]} is not a workspace role.`)
			}
			// A role owned by another workspace would let one tenant's composition
			// govern another's members.
			if (role.organizationId && role.organizationId !== workspaceId) {
				throw new NotFoundError("Role")
			}
			return role
		})

		if (resolved.length === 0) {
			throw new ValidationError("A member must hold at least one role.")
		}

		await rbacRepository.replaceMemberRoles(memberId, roleIds, actor.id)
		await permissionService.invalidateMember(memberId)

		await auditService.record({
			action: "rbac.member_roles.set",
			actorId: actor.id,
			organizationId: workspaceId,
			targetType: "member",
			targetId: memberId,
			metadata: { roles: resolved.map((role) => role.key) },
		})

		return rbacRepository.listMemberRoles(memberId)
	},

	/**
	 * The roles a workspace may assign: the built-in four plus its own.
	 *
	 * A role belonging to another workspace is never selected — the filter is in
	 * the statement, not applied afterwards (`.claude/rules/security.md`).
	 */
	async listWorkspaceRoles(workspaceId: string) {
		const roles = await rbacRepository.listRoles(workspaceId)
		const workspaceScoped = roles.filter((role) => role.scope === "workspace")

		return Promise.all(
			workspaceScoped.map(async (role) => ({
				...role,
				permissions: await rbacRepository.listRolePermissionKeys(role.id),
			})),
		)
	},

	/**
	 * A role a workspace owns.
	 *
	 * The escalation guard is different from the platform one: the actor is a
	 * member, not a console administrator, so the permission they must already
	 * hold is the *workspace* one. Without this an `admin` could compose a role
	 * carrying `workspace.delete` and hand it to themselves, which is the
	 * workspace-level version of the hole ADR-050 closes for the console.
	 */
	async createWorkspaceRole(
		workspaceId: string,
		membership: MembershipRow,
		input: CreateWorkspaceRoleInput,
		actor: AuthUser,
	) {
		await assertMemberMayGrant(membership, input.permissions)

		const existing = await rbacRepository.listRoles(workspaceId)
		if (existing.some((role) => role.key === input.key && role.scope === "workspace")) {
			throw new ConflictError("A role with that key already exists in this workspace.")
		}

		const id = newId()
		await rbacRepository.createRole(
			{
				id,
				organizationId: workspaceId,
				scope: "workspace",
				key: input.key,
				name: input.name,
				description: input.description,
				isSystem: false,
				createdBy: actor.id,
			},
			input.permissions,
		)

		await auditService.record({
			action: "rbac.workspace_role.created",
			actorId: actor.id,
			organizationId: workspaceId,
			targetType: "role",
			targetId: id,
			metadata: { key: input.key, permissions: input.permissions },
		})

		return rbacService.getRole(id)
	},

	async updateWorkspaceRole(
		workspaceId: string,
		membership: MembershipRow,
		roleId: string,
		input: UpdateRoleInput,
		actor: AuthUser,
	) {
		const role = await requireWorkspaceOwnedRole(workspaceId, roleId)

		if (input.permissions) {
			await assertPermissionsMatchScope("workspace", input.permissions)
			await assertMemberMayGrant(membership, input.permissions)
		}

		await rbacRepository.updateRole(
			roleId,
			{
				...(input.name === undefined ? {} : { name: input.name }),
				...(input.description === undefined ? {} : { description: input.description }),
			},
			input.permissions,
		)

		if (input.permissions) await permissionService.invalidateAll()

		await auditService.record({
			action: "rbac.workspace_role.updated",
			actorId: actor.id,
			organizationId: workspaceId,
			targetType: "role",
			targetId: roleId,
			metadata: { permissions: input.permissions ?? null },
		})

		return rbacService.getRole(roleId)
	},

	async deleteWorkspaceRole(workspaceId: string, roleId: string, actor: AuthUser) {
		const role = await requireWorkspaceOwnedRole(workspaceId, roleId)

		const holders = await rbacRepository.countRoleHolders(roleId)
		if (holders > 0) {
			throw new ConflictError(
				`${holders} ${holders === 1 ? "person holds" : "people hold"} this role. Reassign them first.`,
			)
		}

		await rbacRepository.deleteRole(roleId)
		await permissionService.invalidateAll()

		await auditService.record({
			action: "rbac.workspace_role.deleted",
			actorId: actor.id,
			organizationId: workspaceId,
			targetType: "role",
			targetId: roleId,
			metadata: { key: role.key },
		})
	},
}

/**
 * A member cannot compose a role granting more than they themselves hold.
 *
 * The workspace-level twin of `assertMayGrant`. Without it an `admin` — who may
 * manage roles — could write one carrying `workspace.delete`, assign it to
 * themselves, and the distinction between `admin` and `owner` would be a
 * formality.
 */
async function assertMemberMayGrant(
	membership: MembershipRow,
	keys: readonly string[],
): Promise<void> {
	const held = await permissionService.forMember(membership.id)
	const missing = keys.filter((key) => !held.has(key))

	if (missing.length > 0) {
		throw new ForbiddenError(
			`You cannot grant a permission you do not hold: ${missing.join(", ")}.`,
		)
	}
}

/**
 * A role this workspace owns and may therefore edit.
 *
 * A built-in role is refused rather than edited: it is shared by every workspace
 * on the deployment, and the seeder resets it on every deploy anyway. A role
 * owned by another workspace answers 404, not 403 — the other answer confirms it
 * exists.
 */
async function requireWorkspaceOwnedRole(workspaceId: string, roleId: string) {
	const role = await rbacRepository.findRoleById(roleId)
	if (!role || role.scope !== "workspace") throw new NotFoundError("Role")
	if (role.organizationId !== workspaceId) {
		if (role.organizationId === null) {
			throw new ForbiddenError(
				"This is a built-in role, shared by every workspace. Create your own role instead.",
			)
		}
		throw new NotFoundError("Role")
	}
	return role
}
