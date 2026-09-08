/**
 * The permission catalogue — the one list of things a caller may be allowed to do.
 *
 * This file is the source of truth. The `permission` table is a reconciled copy of
 * it (see `src/modules/rbac/rbac.seed.ts`), which is what makes a permission
 * *storable*: a role in the database references a key from here, so an
 * administrator can compose roles at run time without a deploy, while the set of
 * things that can be composed stays code-reviewed.
 *
 * A key is `<resource>.<action>` and is globally unique across both scopes, which
 * is why every platform key carries an `admin.` prefix — `model.read` in a
 * workspace and `model.read` in the console are different questions with different
 * blast radii, and one row cannot answer both.
 *
 * Keys are permanent. Renaming one orphans every custom role that references it,
 * so add a new key and retire the old one rather than editing a string here.
 */

export type PermissionScope = "workspace" | "platform"

/**
 * Resources a permission can be narrowed to for a single row (`resource_grant`).
 * Only entities a customer names and shares are here — there is no point granting
 * "this one conversation" when conversations are already private to their author.
 */
export const GRANTABLE_RESOURCE_TYPES = ["project", "knowledgeBase", "agent"] as const
export type GrantableResourceType = (typeof GRANTABLE_RESOURCE_TYPES)[number]

export type PermissionDefinition = {
	readonly key: string
	readonly scope: PermissionScope
	readonly resource: string
	readonly action: string
	readonly description: string
	/** Set when this permission can also be granted on one resource at a time. */
	readonly grantableOn?: GrantableResourceType
}

/**
 * What a member of a workspace may do inside it.
 *
 * Almost every entry mirrors a route that exists today — a permission with
 * nothing enforcing it reads on the roles screen as a control that does
 * something. The exceptions are named here rather than left to be discovered:
 * `role.*` is enforced from phase 4 of `PLATFORM-ROADMAP.md` and `apiKey.*` from
 * phase 16, and both are in the catalogue now because a role composed today
 * should not need re-composing when they land.
 */
const WORKSPACE_PERMISSIONS = [
	{
		key: "workspace.read",
		scope: "workspace",
		resource: "workspace",
		action: "read",
		description: "See the workspace and its settings",
	},
	{
		key: "workspace.update",
		scope: "workspace",
		resource: "workspace",
		action: "update",
		description: "Change the workspace name, slug and settings",
	},
	{
		key: "workspace.delete",
		scope: "workspace",
		resource: "workspace",
		action: "delete",
		description: "Delete the workspace and everything in it",
	},

	{
		key: "member.read",
		scope: "workspace",
		resource: "member",
		action: "read",
		description: "See who is in the workspace",
	},
	{
		key: "member.update",
		scope: "workspace",
		resource: "member",
		action: "update",
		description: "Change what a member is allowed to do",
	},
	{
		key: "member.remove",
		scope: "workspace",
		resource: "member",
		action: "remove",
		description: "Remove a member from the workspace",
	},

	{
		key: "invitation.read",
		scope: "workspace",
		resource: "invitation",
		action: "read",
		description: "See pending invitations",
	},
	{
		key: "invitation.create",
		scope: "workspace",
		resource: "invitation",
		action: "create",
		description: "Invite somebody to the workspace",
	},
	{
		key: "invitation.revoke",
		scope: "workspace",
		resource: "invitation",
		action: "revoke",
		description: "Cancel a pending invitation",
	},

	{
		key: "role.read",
		scope: "workspace",
		resource: "role",
		action: "read",
		description: "See the roles the workspace can assign",
	},
	{
		key: "role.manage",
		scope: "workspace",
		resource: "role",
		action: "manage",
		description: "Create and edit the workspace's own roles",
	},

	{
		key: "project.read",
		scope: "workspace",
		resource: "project",
		action: "read",
		description: "See projects",
		grantableOn: "project",
	},
	{
		key: "project.create",
		scope: "workspace",
		resource: "project",
		action: "create",
		description: "Create a project",
	},
	{
		key: "project.update",
		scope: "workspace",
		resource: "project",
		action: "update",
		description: "Change a project",
		grantableOn: "project",
	},
	{
		key: "project.archive",
		scope: "workspace",
		resource: "project",
		action: "archive",
		description: "Archive and restore a project",
		grantableOn: "project",
	},
	{
		key: "project.delete",
		scope: "workspace",
		resource: "project",
		action: "delete",
		description: "Delete a project",
		grantableOn: "project",
	},

	{
		key: "knowledgeBase.read",
		scope: "workspace",
		resource: "knowledgeBase",
		action: "read",
		description: "See knowledge bases and search them",
		grantableOn: "knowledgeBase",
	},
	{
		key: "knowledgeBase.create",
		scope: "workspace",
		resource: "knowledgeBase",
		action: "create",
		description: "Create a knowledge base",
	},
	{
		key: "knowledgeBase.update",
		scope: "workspace",
		resource: "knowledgeBase",
		action: "update",
		description: "Change a knowledge base's settings",
		grantableOn: "knowledgeBase",
	},
	{
		key: "knowledgeBase.delete",
		scope: "workspace",
		resource: "knowledgeBase",
		action: "delete",
		description: "Delete a knowledge base and its documents",
		grantableOn: "knowledgeBase",
	},

	{
		key: "document.read",
		scope: "workspace",
		resource: "document",
		action: "read",
		description: "Read documents, their passages and their download",
		grantableOn: "knowledgeBase",
	},
	{
		key: "document.create",
		scope: "workspace",
		resource: "document",
		action: "create",
		description: "Upload a document",
		grantableOn: "knowledgeBase",
	},
	{
		key: "document.update",
		scope: "workspace",
		resource: "document",
		action: "update",
		description: "Re-index a document or cancel its indexing",
		grantableOn: "knowledgeBase",
	},
	{
		key: "document.delete",
		scope: "workspace",
		resource: "document",
		action: "delete",
		description: "Delete a document",
		grantableOn: "knowledgeBase",
	},

	{
		key: "conversation.read",
		scope: "workspace",
		resource: "conversation",
		action: "read",
		description: "Read conversations and their messages",
	},
	{
		key: "conversation.create",
		scope: "workspace",
		resource: "conversation",
		action: "create",
		description: "Start a conversation",
	},
	{
		key: "conversation.update",
		scope: "workspace",
		resource: "conversation",
		action: "update",
		description: "Rename a conversation and change its retrieval settings",
	},
	{
		key: "conversation.delete",
		scope: "workspace",
		resource: "conversation",
		action: "delete",
		description: "Delete a conversation",
	},
	{
		key: "chat.send",
		scope: "workspace",
		resource: "chat",
		action: "send",
		description: "Send a message, which calls a model and spends credits",
	},

	{
		key: "agent.read",
		scope: "workspace",
		resource: "agent",
		action: "read",
		description: "See agents and their versions",
		grantableOn: "agent",
	},
	{
		key: "agent.create",
		scope: "workspace",
		resource: "agent",
		action: "create",
		description: "Create an agent",
	},
	{
		key: "agent.update",
		scope: "workspace",
		resource: "agent",
		action: "update",
		description: "Change an agent's draft",
		grantableOn: "agent",
	},
	{
		key: "agent.publish",
		scope: "workspace",
		resource: "agent",
		action: "publish",
		description: "Publish a version of an agent",
		grantableOn: "agent",
	},
	{
		key: "agent.delete",
		scope: "workspace",
		resource: "agent",
		action: "delete",
		description: "Delete an agent",
		grantableOn: "agent",
	},
	{
		key: "agent.run",
		scope: "workspace",
		resource: "agent",
		action: "run",
		description: "Run an agent, which calls models and spends credits",
		grantableOn: "agent",
	},

	{
		key: "agentRun.read",
		scope: "workspace",
		resource: "agentRun",
		action: "read",
		description: "See runs and the steps they took",
	},
	{
		key: "agentRun.control",
		scope: "workspace",
		resource: "agentRun",
		action: "control",
		description: "Stop, resume, retry a run and answer its approvals",
	},

	{
		key: "attachment.read",
		scope: "workspace",
		resource: "attachment",
		action: "read",
		description: "Open a file somebody attached",
	},
	{
		key: "attachment.create",
		scope: "workspace",
		resource: "attachment",
		action: "create",
		description: "Attach a file to a message or a run",
	},
	{
		key: "attachment.delete",
		scope: "workspace",
		resource: "attachment",
		action: "delete",
		description: "Delete an attachment",
	},

	{
		key: "speech.transcribe",
		scope: "workspace",
		resource: "speech",
		action: "transcribe",
		description: "Turn a recording into text, which spends credits",
	},
	{
		key: "speech.synthesize",
		scope: "workspace",
		resource: "speech",
		action: "synthesize",
		description: "Turn text into audio, which spends credits",
	},

	{
		key: "model.read",
		scope: "workspace",
		resource: "model",
		action: "read",
		description: "See which models the workspace can use",
	},
	{
		key: "model.manage",
		scope: "workspace",
		resource: "model",
		action: "manage",
		description: "Choose the workspace's default and allowed models",
	},

	{
		key: "connection.read",
		scope: "workspace",
		resource: "connection",
		action: "read",
		description: "See the outside systems agents may reach",
	},
	{
		key: "connection.manage",
		scope: "workspace",
		resource: "connection",
		action: "manage",
		description: "Add, change and remove a connection and its stored secret",
	},

	{
		key: "mcpServer.read",
		scope: "workspace",
		resource: "mcpServer",
		action: "read",
		description: "See the MCP servers this workspace's agents may reach",
	},
	{
		key: "mcpServer.manage",
		scope: "workspace",
		resource: "mcpServer",
		action: "manage",
		description: "Add, change and remove an MCP server and its stored key",
	},

	{
		key: "billing.read",
		scope: "workspace",
		resource: "billing",
		action: "read",
		description: "See the plan, the balance and the invoices",
	},
	{
		key: "billing.manage",
		scope: "workspace",
		resource: "billing",
		action: "manage",
		description: "Change the plan, buy credits and set auto-reload",
	},
	{
		key: "transaction.read",
		scope: "workspace",
		resource: "transaction",
		action: "read",
		description: "Read the credit ledger — what every member spent",
	},
	{
		key: "usage.read",
		scope: "workspace",
		resource: "usage",
		action: "read",
		description: "See what has been spent and on what",
	},
	{
		key: "promo.read",
		scope: "workspace",
		resource: "promo",
		action: "read",
		description: "See the promotional codes this workspace has redeemed",
	},
	{
		key: "promo.redeem",
		scope: "workspace",
		resource: "promo",
		action: "redeem",
		description: "Redeem a promotional code for credits",
	},

	{
		key: "apiKey.read",
		scope: "workspace",
		resource: "apiKey",
		action: "read",
		description: "See the workspace's API keys and when they were last used",
	},
	{
		key: "apiKey.create",
		scope: "workspace",
		resource: "apiKey",
		action: "create",
		description: "Create an API key",
	},
	{
		key: "apiKey.revoke",
		scope: "workspace",
		resource: "apiKey",
		action: "revoke",
		description: "Revoke an API key",
	},

	{
		key: "audit.read",
		scope: "workspace",
		resource: "audit",
		action: "read",
		description: "Read the workspace's audit trail",
	},
] as const satisfies readonly PermissionDefinition[]

/**
 * What somebody may do in the admin console, across every workspace.
 *
 * This is where `requireAdmin` used to be one boolean. Reading the audit log and
 * adjusting a workspace's credits are not the same risk, and until these existed
 * there was no way to say so.
 */
const PLATFORM_PERMISSIONS = [
	{
		key: "admin.console.access",
		scope: "platform",
		resource: "admin.console",
		action: "access",
		description: "Sign in to the admin console at all",
	},

	{
		key: "admin.user.read",
		scope: "platform",
		resource: "admin.user",
		action: "read",
		description: "List and inspect user accounts",
	},
	{
		key: "admin.user.manage",
		scope: "platform",
		resource: "admin.user",
		action: "manage",
		description: "Ban, unban and revoke the sessions of a user",
	},
	{
		key: "admin.user.impersonate",
		scope: "platform",
		resource: "admin.user",
		action: "impersonate",
		description: "Act as another user",
	},

	{
		key: "admin.workspace.read",
		scope: "platform",
		resource: "admin.workspace",
		action: "read",
		description: "List and inspect any workspace",
	},
	{
		key: "admin.workspace.manage",
		scope: "platform",
		resource: "admin.workspace",
		action: "manage",
		description: "Change a workspace's plan",
	},
	{
		key: "admin.credit.adjust",
		scope: "platform",
		resource: "admin.credit",
		action: "adjust",
		description: "Grant or take back a workspace's credits",
	},

	{
		key: "admin.usage.read",
		scope: "platform",
		resource: "admin.usage",
		action: "read",
		description: "See what every model and workspace has spent, across the platform",
	},

	{
		key: "admin.promo.read",
		scope: "platform",
		resource: "admin.promo",
		action: "read",
		description: "See promotional codes and their redemptions",
	},
	{
		key: "admin.promo.manage",
		scope: "platform",
		resource: "admin.promo",
		action: "manage",
		description: "Create, change and deactivate promotional codes",
	},

	{
		key: "admin.provider.read",
		scope: "platform",
		resource: "admin.provider",
		action: "read",
		description: "See which model providers are configured",
	},
	{
		key: "admin.provider.manage",
		scope: "platform",
		resource: "admin.provider",
		action: "manage",
		description: "Store, test and remove a provider's API key",
	},
	{
		key: "admin.model.read",
		scope: "platform",
		resource: "admin.model",
		action: "read",
		description: "See the model catalogue and its prices",
	},
	{
		key: "admin.model.manage",
		scope: "platform",
		resource: "admin.model",
		action: "manage",
		description: "Import, price and enable models, and set the platform defaults",
	},
	{
		key: "admin.speech.read",
		scope: "platform",
		resource: "admin.speech",
		action: "read",
		description: "See how speech is configured",
	},
	{
		key: "admin.speech.manage",
		scope: "platform",
		resource: "admin.speech",
		action: "manage",
		description: "Point speech at an endpoint and store its key",
	},

	{
		key: "admin.integration.read",
		scope: "platform",
		resource: "admin.integration",
		action: "read",
		description: "See the platform-wide connections agents may reach",
	},
	{
		key: "admin.integration.manage",
		scope: "platform",
		resource: "admin.integration",
		action: "manage",
		description: "Add, change and remove a platform-wide connection",
	},

	{
		key: "admin.mcp.read",
		scope: "platform",
		resource: "admin.mcp",
		action: "read",
		description: "See the MCP servers configured for the whole deployment",
	},
	{
		key: "admin.mcp.manage",
		scope: "platform",
		resource: "admin.mcp",
		action: "manage",
		description: "Add, change and remove a deployment-wide MCP server",
	},

	{
		key: "admin.role.read",
		scope: "platform",
		resource: "admin.role",
		action: "read",
		description: "See roles and what each one may do",
	},
	{
		key: "admin.role.manage",
		scope: "platform",
		resource: "admin.role",
		action: "manage",
		description: "Create roles, change their permissions and assign them",
	},

	{
		key: "admin.audit.read",
		scope: "platform",
		resource: "admin.audit",
		action: "read",
		description: "Read the platform audit trail",
	},
	{
		key: "admin.setting.read",
		scope: "platform",
		resource: "admin.setting",
		action: "read",
		description: "See platform settings",
	},
	{
		key: "admin.setting.manage",
		scope: "platform",
		resource: "admin.setting",
		action: "manage",
		description: "Change platform settings",
	},
] as const satisfies readonly PermissionDefinition[]

/**
 * Widened to `PermissionDefinition` on purpose. The two lists above keep their
 * literal types so `PermissionKey` can be derived from them, but a literal type
 * omits `grantableOn` on every entry that does not declare it — and a caller
 * iterating the catalogue has to be able to ask.
 */
export const PERMISSIONS: readonly PermissionDefinition[] = [
	...WORKSPACE_PERMISSIONS,
	...PLATFORM_PERMISSIONS,
]

export type WorkspacePermissionKey = (typeof WORKSPACE_PERMISSIONS)[number]["key"]
export type PlatformPermissionKey = (typeof PLATFORM_PERMISSIONS)[number]["key"]
export type PermissionKey = WorkspacePermissionKey | PlatformPermissionKey

const workspaceKeys = WORKSPACE_PERMISSIONS.map((p) => p.key)
const platformKeys = PLATFORM_PERMISSIONS.map((p) => p.key)

export const WORKSPACE_PERMISSION_KEYS: readonly WorkspacePermissionKey[] = workspaceKeys
export const PLATFORM_PERMISSION_KEYS: readonly PlatformPermissionKey[] = platformKeys

/**
 * Reads that are not "seeing the product" but "seeing how the workspace is run".
 *
 * `action === "read"` is a good enough rule for the rest of the catalogue and a
 * wrong one for these four: the pending-invitation list is the membership
 * pipeline, the credit ledger names what every member spent, the audit trail is
 * who did what, and an API key list names the automations that hold the
 * workspace's credentials. Each was gated to owner/admin before permissions
 * existed, and treating them as ordinary reads would have quietly widened them.
 */
const RESTRICTED_READ_KEYS: readonly string[] = [
	"invitation.read",
	"transaction.read",
	"audit.read",
	"apiKey.read",
]

/** The reads any member of a workspace gets, and everything a viewer gets. */
const generalReadKeys = WORKSPACE_PERMISSIONS.filter(
	(p) => p.action === "read" && !RESTRICTED_READ_KEYS.includes(p.key),
).map((p) => p.key)

const permissionsByKey = new Map<string, PermissionDefinition>(PERMISSIONS.map((p) => [p.key, p]))

export function findPermission(key: string): PermissionDefinition | undefined {
	return permissionsByKey.get(key)
}

export function isPermissionKey(key: string): key is PermissionKey {
	return permissionsByKey.has(key)
}

export type SystemRoleDefinition = {
	readonly key: string
	readonly scope: PermissionScope
	readonly name: string
	readonly description: string
	readonly permissions: readonly PermissionKey[]
}

/**
 * The four workspace roles, unchanged in name and in what they may do.
 *
 * These sets reproduce the `requireWorkspaceRole` gates that were on the routes
 * before permissions existed, verb for verb — the migration to permission checks
 * has to be invisible to anyone using the product. Where the old compiled access
 * table in `permissions.ts` disagreed with a route (it gave `admin` only
 * `billing: ["read"]` while the billing routes admitted `admin`), the **route**
 * is taken as the truth, because the route is what was enforced.
 */
const WORKSPACE_SYSTEM_ROLES = [
	{
		key: "owner",
		scope: "workspace",
		name: "Owner",
		description: "Full control of the workspace, including deleting it",
		permissions: workspaceKeys,
	},
	{
		key: "admin",
		scope: "workspace",
		name: "Admin",
		description: "Runs the workspace day to day; cannot delete it",
		permissions: workspaceKeys.filter(
			(key) => key !== "workspace.delete" && key !== "project.delete",
		),
	},
	{
		key: "member",
		scope: "workspace",
		name: "Member",
		description: "Builds and runs things; cannot change members, billing or connections",
		permissions: [
			...generalReadKeys,
			"project.create",
			"project.update",
			"knowledgeBase.create",
			"knowledgeBase.update",
			"document.create",
			"document.update",
			"document.delete",
			"conversation.create",
			"conversation.update",
			"conversation.delete",
			"chat.send",
			"agent.create",
			"agent.update",
			"agent.publish",
			"agent.delete",
			"agent.run",
			"agentRun.control",
			"attachment.create",
			"attachment.delete",
			"speech.transcribe",
			"speech.synthesize",
		],
	},
	{
		key: "viewer",
		scope: "workspace",
		name: "Viewer",
		description: "Reads everything and spends nothing",
		permissions: generalReadKeys,
	},
] as const satisfies readonly SystemRoleDefinition[]

/**
 * Platform roles. `superadmin` is the only one that may edit roles, and
 * `ADMIN_USER_IDS` in the environment grants it without a database row — see
 * `require-admin.ts`. That is the break-glass path: a role edit that locks
 * everybody out has to be recoverable without a migration.
 */
const PLATFORM_SYSTEM_ROLES = [
	{
		key: "superadmin",
		scope: "platform",
		name: "Super administrator",
		description: "Everything in the console, including who else may use it",
		permissions: platformKeys,
	},
	{
		key: "support",
		scope: "platform",
		name: "Support",
		description: "Reads everything and can act as a customer to reproduce a problem",
		permissions: [
			"admin.console.access",
			"admin.user.read",
			"admin.user.impersonate",
			"admin.workspace.read",
			"admin.promo.read",
			"admin.provider.read",
			"admin.model.read",
			"admin.speech.read",
			"admin.integration.read",
			"admin.mcp.read",
			"admin.role.read",
			"admin.audit.read",
			"admin.setting.read",
		],
	},
	{
		key: "finance",
		scope: "platform",
		name: "Finance",
		description: "Credits, plans and promotional codes; no keys and no user accounts",
		permissions: [
			"admin.console.access",
			"admin.workspace.read",
			"admin.workspace.manage",
			"admin.credit.adjust",
			"admin.usage.read",
			"admin.promo.read",
			"admin.promo.manage",
			"admin.model.read",
			"admin.audit.read",
		],
	},
	{
		key: "auditor",
		scope: "platform",
		name: "Auditor",
		description: "Reads the console and changes nothing",
		permissions: [
			"admin.console.access",
			"admin.user.read",
			"admin.workspace.read",
			"admin.usage.read",
			"admin.promo.read",
			"admin.provider.read",
			"admin.model.read",
			"admin.speech.read",
			"admin.integration.read",
			"admin.mcp.read",
			"admin.role.read",
			"admin.audit.read",
			"admin.setting.read",
		],
	},
] as const satisfies readonly SystemRoleDefinition[]

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
	...WORKSPACE_SYSTEM_ROLES,
	...PLATFORM_SYSTEM_ROLES,
]

export type WorkspaceRoleKey = (typeof WORKSPACE_SYSTEM_ROLES)[number]["key"]
export type PlatformRoleKey = (typeof PLATFORM_SYSTEM_ROLES)[number]["key"]

export const WORKSPACE_SYSTEM_ROLE_KEYS = WORKSPACE_SYSTEM_ROLES.map(
	(role) => role.key,
) as WorkspaceRoleKey[]

export const PLATFORM_SYSTEM_ROLE_KEYS = PLATFORM_SYSTEM_ROLES.map(
	(role) => role.key,
) as PlatformRoleKey[]

/** The id a system role is stored under, so the seeder and a lookup agree. */
export function systemRoleId(scope: PermissionScope, key: string): string {
	return `system:${scope}:${key}`
}

export function findSystemRole(
	scope: PermissionScope,
	key: string,
): SystemRoleDefinition | undefined {
	return SYSTEM_ROLES.find((role) => role.scope === scope && role.key === key)
}
