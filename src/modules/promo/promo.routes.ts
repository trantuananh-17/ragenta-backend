import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requireWorkspaceRole, workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { promoController } from "./promo.controller"

/**
 * Redeeming a code adds credits the whole workspace spends, so it is an
 * owner/admin action for the same reason changing the plan is. Reading which
 * codes were already used is open to any member — it explains a balance.
 */
export const promoRoutes = new Hono<AppEnv>()

promoRoutes.use("*", requireAuth)

promoRoutes.get(
	"/:workspaceId/billing/promo-codes",
	workspaceScope,
	promoController.listWorkspaceRedemptions,
)
promoRoutes.post(
	"/:workspaceId/billing/promo-codes/redeem",
	workspaceScope,
	requireWorkspaceRole("owner", "admin"),
	promoController.redeem,
)
