import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requireWorkspaceRole, workspaceScope } from "../../api/middleware/workspace-scope"
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
	requireWorkspaceRole("owner", "admin"),
	workspaceController.update,
)

workspaceRoutes.get("/:workspaceId/members", workspaceScope, workspaceController.listMembers)
workspaceRoutes.patch(
	"/:workspaceId/members/:memberId",
	workspaceScope,
	requireWorkspaceRole("owner", "admin"),
	workspaceController.updateMemberRole,
)
workspaceRoutes.delete(
	"/:workspaceId/members/:memberId",
	workspaceScope,
	requireWorkspaceRole("owner", "admin"),
	workspaceController.removeMember,
)

workspaceRoutes.get(
	"/:workspaceId/invitations",
	workspaceScope,
	requireWorkspaceRole("owner", "admin"),
	workspaceController.listInvitations,
)
workspaceRoutes.post(
	"/:workspaceId/invitations",
	workspaceScope,
	requireWorkspaceRole("owner", "admin"),
	workspaceController.invite,
)
workspaceRoutes.delete(
	"/:workspaceId/invitations/:invitationId",
	workspaceScope,
	requireWorkspaceRole("owner", "admin"),
	workspaceController.cancelInvitation,
)
