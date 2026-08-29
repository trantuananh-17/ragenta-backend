import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { usageController } from "./usage.controller"

/**
 * Usage is visible to every member: people need to see what their own work
 * costs. The credit ledger, which is the money view, stays owner/admin.
 */
export const usageRoutes = new Hono<AppEnv>()

usageRoutes.use("*", requireAuth)

usageRoutes.get("/:workspaceId/usage", workspaceScope, usageController.summary)
usageRoutes.get("/:workspaceId/usage/records", workspaceScope, usageController.list)

// Which models this workspace's plan entitles it to — what a model picker reads.
usageRoutes.get("/:workspaceId/models", workspaceScope, usageController.models)
