import { createAccessControl } from "better-auth/plugins/access"
import {
	adminAc,
	defaultStatements,
	memberAc,
	ownerAc,
} from "better-auth/plugins/organization/access"

/**
 * Workspace roles and what each may do.
 *
 * `defaultStatements` covers the membership primitives the organization plugin
 * enforces itself (organization, member, invitation). Everything below it is
 * Ragenta's own surface, checked by our services — the access controller is the
 * single table both sides read, so a permission question has one answer.
 */
const statements = {
	...defaultStatements,
	project: ["create", "read", "update", "delete"],
	knowledgeBase: ["create", "read", "update", "delete"],
	agent: ["create", "read", "update", "delete", "run"],
	apiKey: ["create", "read", "revoke"],
	billing: ["read", "manage"],
} as const

export const ac = createAccessControl(statements)

const fullAccess = {
	project: ["create", "read", "update", "delete"],
	knowledgeBase: ["create", "read", "update", "delete"],
	agent: ["create", "read", "update", "delete", "run"],
	apiKey: ["create", "read", "revoke"],
} as const

export const owner = ac.newRole({
	...ownerAc.statements,
	...fullAccess,
	billing: ["read", "manage"],
})

export const admin = ac.newRole({
	...adminAc.statements,
	...fullAccess,
	billing: ["read"],
})

export const member = ac.newRole({
	...memberAc.statements,
	project: ["create", "read", "update"],
	knowledgeBase: ["create", "read", "update"],
	agent: ["create", "read", "update", "run"],
	apiKey: ["read"],
	billing: ["read"],
})

/** Read-only seat: sees the workspace and can run nothing that spends credits. */
export const viewer = ac.newRole({
	...memberAc.statements,
	project: ["read"],
	knowledgeBase: ["read"],
	agent: ["read"],
	billing: ["read"],
})

export const roles = { owner, admin, member, viewer }

export type WorkspaceRole = keyof typeof roles

export const WORKSPACE_ROLES = Object.keys(roles) as WorkspaceRole[]

/** Roles allowed to change workspace settings, members and invitations. */
export const WORKSPACE_MANAGER_ROLES: WorkspaceRole[] = ["owner", "admin"]

export function isWorkspaceRole(value: string): value is WorkspaceRole {
	return (WORKSPACE_ROLES as string[]).includes(value)
}
