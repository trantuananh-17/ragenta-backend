import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requireWorkspaceRole, workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { billingController } from "./billing.controller"

/**
 * Mounted alongside the workspace routes on `/v1/workspaces`, so the paths carry
 * the `:workspaceId` segment themselves and the tenant guard is visible on every
 * line.
 */
export const billingRoutes = new Hono<AppEnv>()

billingRoutes.use("*", requireAuth)

billingRoutes.get("/:workspaceId/billing", workspaceScope, billingController.summary)

// The ledger names what every member spent — a workspace administration view.
billingRoutes.get(
	"/:workspaceId/billing/transactions",
	workspaceScope,
	requireWorkspaceRole("owner", "admin"),
	billingController.transactions,
)
