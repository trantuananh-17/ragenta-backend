import { Hono } from "hono"

import { requirePermission } from "../../api/middleware/require-permission"
import { requireAuth } from "../../api/middleware/session"
import { workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { observabilityController } from "../observability/observability.controller"
import { usageController } from "./usage.controller"

/**
 * Usage is visible to every member: people need to see what their own work
 * costs. The credit ledger, which is the money view, stays owner/admin.
 */
export const usageRoutes = new Hono<AppEnv>()

usageRoutes.use("*", requireAuth)

usageRoutes.get("/:workspaceId/usage", workspaceScope, usageController.summary)
usageRoutes.get("/:workspaceId/usage/records", workspaceScope, usageController.list)

/**
 * A workspace's own failed provider calls.
 *
 * Behind `usage.read` rather than a new permission: it answers the same question
 * usage does — what has this workspace's AI been doing — from the other side.
 */
usageRoutes.get(
	"/:workspaceId/provider-errors",
	workspaceScope,
	requirePermission("usage.read"),
	observabilityController.listWorkspaceErrors,
)
