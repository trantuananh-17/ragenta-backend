import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requirePermission } from "../../api/middleware/require-permission"
import { workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { mcpController } from "../mcp/mcp.controller"
import { rbacController } from "../rbac/rbac.controller"
import { workspaceController } from "./workspace.controller"

/**
 * Route table for `/v1/workspaces`. Read it as the authorization map: every
 * `:workspaceId` route carries `workspaceScope` (membership), and the ones that
 * change people or settings additionally carry a role guard.
 */
export const workspaceRoutes = new Hono<AppEnv>()

workspaceRoutes.use("*", requireAuth)

workspaceRoutes.get("/", workspaceController.list)
workspaceRoutes.post("/", workspaceController.create)

workspaceRoutes.get("/:workspaceId", workspaceScope, workspaceController.get)
workspaceRoutes.patch(
	"/:workspaceId",
	workspaceScope,
	requirePermission("workspace.update"),
	workspaceController.update,
)

// No permission guard: this *is* the permission answer, and a seat that cannot
// read it has no way to render anything correctly.
workspaceRoutes.get(
	"/:workspaceId/permissions",
	workspaceScope,
	workspaceController.listPermissions,
)

workspaceRoutes.get("/:workspaceId/members", workspaceScope, workspaceController.listMembers)
workspaceRoutes.patch(
	"/:workspaceId/members/:memberId",
	workspaceScope,
	requirePermission("member.update"),
	workspaceController.updateMemberRole,
)
workspaceRoutes.delete(
	"/:workspaceId/members/:memberId",
	workspaceScope,
	requirePermission("member.remove"),
	workspaceController.removeMember,
)

workspaceRoutes.get(
	"/:workspaceId/invitations",
	workspaceScope,
	requirePermission("invitation.read"),
	workspaceController.listInvitations,
)
workspaceRoutes.post(
	"/:workspaceId/invitations",
	workspaceScope,
	requirePermission("invitation.create"),
	workspaceController.invite,
)
workspaceRoutes.delete(
	"/:workspaceId/invitations/:invitationId",
	workspaceScope,
	requirePermission("invitation.revoke"),
	workspaceController.cancelInvitation,
)

/**
 * A workspace composing its own roles, without going through the admin console.
 *
 * Reading is open to any member: the members screen has to name the role each
 * person holds, and a seat that cannot read the list cannot render it. Writing
 * needs `role.manage`, and nobody can compose a role granting more than they
 * themselves hold (ADR-052).
 */
workspaceRoutes.get("/:workspaceId/roles", workspaceScope, rbacController.listWorkspaceRoles)
workspaceRoutes.post(
	"/:workspaceId/roles",
	workspaceScope,
	requirePermission("role.manage"),
	rbacController.createWorkspaceRole,
)
workspaceRoutes.patch(
	"/:workspaceId/roles/:roleId",
	workspaceScope,
	requirePermission("role.manage"),
	rbacController.updateWorkspaceRole,
)
workspaceRoutes.delete(
	"/:workspaceId/roles/:roleId",
	workspaceScope,
	requirePermission("role.manage"),
	rbacController.deleteWorkspaceRole,
)

workspaceRoutes.get(
	"/:workspaceId/members/:memberId/roles",
	workspaceScope,
	rbacController.listWorkspaceMemberRoles,
)
workspaceRoutes.put(
	"/:workspaceId/members/:memberId/roles",
	workspaceScope,
	requirePermission("member.update"),
	rbacController.setWorkspaceMemberRoles,
)

/**
 * The MCP servers this workspace's agents may reach — the deployment's, plus its
 * own. Managing one stores a credential, so it carries the same audience a
 * connection does (ADR-056).
 */
workspaceRoutes.get(
	"/:workspaceId/mcp-servers",
	workspaceScope,
	requirePermission("mcpServer.read"),
	mcpController.listForWorkspace,
)
workspaceRoutes.get(
	"/:workspaceId/mcp-tools",
	workspaceScope,
	requirePermission("mcpServer.read"),
	mcpController.listTools,
)
workspaceRoutes.put(
	"/:workspaceId/mcp-servers",
	workspaceScope,
	requirePermission("mcpServer.manage"),
	mcpController.saveForWorkspace,
)
workspaceRoutes.delete(
	"/:workspaceId/mcp-servers/:serverId",
	workspaceScope,
	requirePermission("mcpServer.manage"),
	mcpController.removeForWorkspace,
)
workspaceRoutes.post(
	"/:workspaceId/mcp-servers/:serverId/check",
	workspaceScope,
	requirePermission("mcpServer.manage"),
	mcpController.checkForWorkspace,
)
