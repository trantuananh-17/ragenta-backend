import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requireWorkspaceRole, workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { modelController } from "./model.controller"

/**
 * Every member can see which models are available and which one is in use —
 * that is part of understanding what a run costs. Changing the default is a
 * workspace-wide decision with a price attached, so it is owner/admin.
 */
export const modelRoutes = new Hono<AppEnv>()

modelRoutes.use("*", requireAuth)

modelRoutes.get("/:workspaceId/models", workspaceScope, modelController.list)
modelRoutes.get("/:workspaceId/settings/models", workspaceScope, modelController.getSettings)
modelRoutes.put(
	"/:workspaceId/settings/models",
	workspaceScope,
	requireWorkspaceRole("owner", "admin"),
	modelController.updateSettings,
)
