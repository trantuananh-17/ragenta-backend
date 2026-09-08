import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requirePermission } from "../../api/middleware/require-permission"
import { requireResourcePermission } from "../../api/middleware/require-resource-permission"
import { workspaceScope } from "../../api/middleware/workspace-scope"
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
	requirePermission("project.create"),
	projectController.create,
)

projectRoutes.get(
	"/:workspaceId/projects/:projectId",
	workspaceScope,
	requireResourcePermission("project.read", "project", "projectId"),
	projectController.get,
)
projectRoutes.patch(
	"/:workspaceId/projects/:projectId",
	workspaceScope,
	requireResourcePermission("project.update", "project", "projectId"),
	projectController.update,
)
projectRoutes.post(
	"/:workspaceId/projects/:projectId/archive",
	workspaceScope,
	requireResourcePermission("project.archive", "project", "projectId"),
	projectController.archive,
)
projectRoutes.post(
	"/:workspaceId/projects/:projectId/restore",
	workspaceScope,
	requireResourcePermission("project.archive", "project", "projectId"),
	projectController.restore,
)
projectRoutes.delete(
	"/:workspaceId/projects/:projectId",
	workspaceScope,
	requireResourcePermission("project.delete", "project", "projectId"),
	projectController.remove,
)
