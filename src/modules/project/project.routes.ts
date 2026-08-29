import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requireWorkspaceRole, workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { projectController } from "./project.controller"

/**
 * Projects live under their workspace, so the tenant guard is the same
 * `workspaceScope` used everywhere else and the project lookup itself is
 * workspace-filtered in the repository.
 *
 * `viewer` can read but not create or change — that role exists so someone can
 * be given sight of a workspace without being able to spend its credits.
 */
export const projectRoutes = new Hono<AppEnv>()

projectRoutes.use("*", requireAuth)

projectRoutes.get("/:workspaceId/projects", workspaceScope, projectController.list)
projectRoutes.post(
	"/:workspaceId/projects",
	workspaceScope,
	requireWorkspaceRole("owner", "admin", "member"),
	projectController.create,
)

projectRoutes.get(
	"/:workspaceId/projects/:projectId",
	workspaceScope,
	projectController.get,
)
projectRoutes.patch(
	"/:workspaceId/projects/:projectId",
	workspaceScope,
	requireWorkspaceRole("owner", "admin", "member"),
	projectController.update,
)
projectRoutes.post(
	"/:workspaceId/projects/:projectId/archive",
	workspaceScope,
	requireWorkspaceRole("owner", "admin"),
	projectController.archive,
)
projectRoutes.post(
	"/:workspaceId/projects/:projectId/restore",
	workspaceScope,
	requireWorkspaceRole("owner", "admin"),
	projectController.restore,
)
projectRoutes.delete(
	"/:workspaceId/projects/:projectId",
	workspaceScope,
	requireWorkspaceRole("owner"),
	projectController.remove,
)
