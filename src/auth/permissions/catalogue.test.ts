import { describe, expect, it } from "vitest"

import {
	PERMISSIONS,
	PLATFORM_PERMISSION_KEYS,
	SYSTEM_ROLES,
	WORKSPACE_PERMISSION_KEYS,
	findSystemRole,
	isPermissionKey,
	systemRoleId,
} from "./catalogue"
import type { PermissionKey, WorkspaceRoleKey } from "./catalogue"

function workspaceRolesHolding(key: PermissionKey): WorkspaceRoleKey[] {
	return SYSTEM_ROLES.filter(
		(role) => role.scope === "workspace" && (role.permissions as readonly string[]).includes(key),
	).map((role) => role.key as WorkspaceRoleKey)
}

describe("permission catalogue", () => {
	it("gives every permission a unique key", () => {
		const keys = PERMISSIONS.map((entry) => entry.key)
		expect(new Set(keys).size).toBe(keys.length)
	})

	it("composes every key from its own resource and action", () => {
		for (const entry of PERMISSIONS) {
			expect(entry.key).toBe(`${entry.resource}.${entry.action}`)
		}
	})

	it("prefixes every platform permission with admin., so no key means two things", () => {
		for (const key of PLATFORM_PERMISSION_KEYS) {
			expect(key.startsWith("admin.")).toBe(true)
		}
		for (const key of WORKSPACE_PERMISSION_KEYS) {
			expect(key.startsWith("admin.")).toBe(false)
		}
	})

	it("offers a per-resource grant only on workspace permissions", () => {
		for (const entry of PERMISSIONS) {
			if (entry.scope === "platform") expect(entry.grantableOn).toBeUndefined()
		}
	})

	it("recognises a key it defines and refuses one it does not", () => {
		expect(isPermissionKey("project.create")).toBe(true)
		expect(isPermissionKey("project.explode")).toBe(false)
	})
})

describe("system roles", () => {
	it("names every permission it grants, and only ones in its own scope", () => {
		for (const role of SYSTEM_ROLES) {
			for (const key of role.permissions) {
				const entry = PERMISSIONS.find((permission) => permission.key === key)
				expect(entry, `${role.key} grants unknown permission ${key}`).toBeDefined()
				expect(entry?.scope, `${role.key} grants out-of-scope ${key}`).toBe(role.scope)
			}
		}
	})

	it("grants each permission at most once per role", () => {
		for (const role of SYSTEM_ROLES) {
			expect(new Set(role.permissions).size).toBe(role.permissions.length)
		}
	})

	it("gives owner everything a workspace has and superadmin everything the platform has", () => {
		expect(findSystemRole("workspace", "owner")?.permissions).toEqual(WORKSPACE_PERMISSION_KEYS)
		expect(findSystemRole("platform", "superadmin")?.permissions).toEqual(PLATFORM_PERMISSION_KEYS)
	})

	it("keeps the workspace roles nested: viewer within member within admin within owner", () => {
		const setOf = (key: string) => new Set(findSystemRole("workspace", key)?.permissions ?? [])
		const [viewer, memberRole, adminRole, ownerRole] = [
			setOf("viewer"),
			setOf("member"),
			setOf("admin"),
			setOf("owner"),
		]

		for (const key of viewer) expect(memberRole.has(key)).toBe(true)
		for (const key of memberRole) expect(adminRole.has(key)).toBe(true)
		for (const key of adminRole) expect(ownerRole.has(key)).toBe(true)
	})

	it("lets a viewer read and spend nothing", () => {
		const viewer = findSystemRole("workspace", "viewer")
		for (const key of viewer?.permissions ?? []) {
			expect(PERMISSIONS.find((entry) => entry.key === key)?.action).toBe("read")
		}
		// The four verbs that reach a paid provider.
		for (const spending of ["chat.send", "agent.run", "speech.transcribe", "speech.synthesize"]) {
			expect(viewer?.permissions).not.toContain(spending)
		}
	})

	it("gives every system role a stable, scope-qualified id", () => {
		expect(systemRoleId("workspace", "owner")).toBe("system:workspace:owner")
		expect(systemRoleId("platform", "owner")).toBe("system:platform:owner")
	})

	it("lets only superadmin change who may use the console", () => {
		const holders = SYSTEM_ROLES.filter(
			(role) =>
				role.scope === "platform" &&
				(role.permissions as readonly string[]).includes("admin.role.manage"),
		).map((role) => role.key)
		expect(holders).toEqual(["superadmin"])
	})
})

/**
 * The cutover guard.
 *
 * Before permissions existed, every restricted route carried
 * `requireWorkspaceRole(...)` with an explicit role list. This table is that list,
 * read off the route files, and the assertion is that the roles holding the
 * matching permission are exactly the roles the route admitted. If a phase-2 edit
 * widens or narrows somebody's access by accident, this is what says so — the
 * migration to permission checks is supposed to be invisible to anybody using the
 * product.
 *
 * A route with no role guard admitted every member, so it maps to all four roles.
 */
const LEGACY_ROUTE_GATES: ReadonlyArray<readonly [PermissionKey, readonly WorkspaceRoleKey[]]> = [
	["workspace.read", ["owner", "admin", "member", "viewer"]],
	["workspace.update", ["owner", "admin"]],
	["member.read", ["owner", "admin", "member", "viewer"]],
	["member.update", ["owner", "admin"]],
	["member.remove", ["owner", "admin"]],
	["invitation.read", ["owner", "admin"]],
	["invitation.create", ["owner", "admin"]],
	["invitation.revoke", ["owner", "admin"]],

	["project.read", ["owner", "admin", "member", "viewer"]],
	["project.create", ["owner", "admin", "member"]],
	["project.update", ["owner", "admin", "member"]],
	["project.archive", ["owner", "admin"]],
	["project.delete", ["owner"]],

	["knowledgeBase.read", ["owner", "admin", "member", "viewer"]],
	["knowledgeBase.create", ["owner", "admin", "member"]],
	["knowledgeBase.update", ["owner", "admin", "member"]],
	["knowledgeBase.delete", ["owner", "admin"]],
	["document.read", ["owner", "admin", "member", "viewer"]],
	["document.create", ["owner", "admin", "member"]],
	["document.update", ["owner", "admin", "member"]],
	["document.delete", ["owner", "admin", "member"]],

	["conversation.read", ["owner", "admin", "member", "viewer"]],
	["conversation.create", ["owner", "admin", "member"]],
	["conversation.update", ["owner", "admin", "member"]],
	["conversation.delete", ["owner", "admin", "member"]],
	["chat.send", ["owner", "admin", "member"]],

	["agent.read", ["owner", "admin", "member", "viewer"]],
	["agent.create", ["owner", "admin", "member"]],
	["agent.update", ["owner", "admin", "member"]],
	["agent.publish", ["owner", "admin", "member"]],
	["agent.delete", ["owner", "admin", "member"]],
	["agent.run", ["owner", "admin", "member"]],
	["agentRun.read", ["owner", "admin", "member", "viewer"]],
	["agentRun.control", ["owner", "admin", "member"]],

	["attachment.read", ["owner", "admin", "member", "viewer"]],
	["attachment.create", ["owner", "admin", "member"]],
	["attachment.delete", ["owner", "admin", "member"]],
	["speech.transcribe", ["owner", "admin", "member"]],
	["speech.synthesize", ["owner", "admin", "member"]],

	["model.read", ["owner", "admin", "member", "viewer"]],
	["model.manage", ["owner", "admin"]],
	["connection.read", ["owner", "admin", "member", "viewer"]],
	["connection.manage", ["owner", "admin"]],
	// New in phase 8, and given the same audience as a connection for the same
	// reason: both hold a credential an agent acts through.
	["widget.read", ["owner", "admin", "member", "viewer"]],
	// Publishing one exposes an endpoint a stranger can reach and that spends the
	// workspace's credits. Same audience as billing.
	["widget.manage", ["owner", "admin"]],
	["dataSource.read", ["owner", "admin", "member", "viewer"]],
	// Approving a query decides what SQL an agent may cause to run against a
	// customer's own database. Same audience as every other credential here.
	["dataSource.manage", ["owner", "admin"]],
	["oauthConnection.read", ["owner", "admin", "member", "viewer"]],
	// Connecting an account means an agent will act *as somebody*, which is a
	// heavier decision than storing a service key — but the audience is the same
	// one that manages every other credential in a workspace.
	["oauthConnection.manage", ["owner", "admin"]],
	["mcpServer.read", ["owner", "admin", "member", "viewer"]],
	["mcpServer.manage", ["owner", "admin"]],
	// New in phase 17b, and deliberately **not** an ordinary read: the list names
	// the URLs this workspace posts its own data to and how each endpoint has been
	// failing. That is the audit log's audience, not a member's.
	["webhook.read", ["owner", "admin"]],
	["webhook.manage", ["owner", "admin"]],

	["billing.read", ["owner", "admin", "member", "viewer"]],
	["transaction.read", ["owner", "admin"]],
	["billing.manage", ["owner", "admin"]],
	["usage.read", ["owner", "admin", "member", "viewer"]],
	["promo.read", ["owner", "admin", "member", "viewer"]],
	["promo.redeem", ["owner", "admin"]],
]

describe("the role gates that were on the routes", () => {
	it.each(LEGACY_ROUTE_GATES)("%s is held by exactly the roles the route admitted", (key, roles) => {
		expect(workspaceRolesHolding(key).sort()).toEqual([...roles].sort())
	})
})
