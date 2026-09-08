import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requirePermission } from "../../api/middleware/require-permission"
import { workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
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
