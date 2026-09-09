import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requirePermission } from "../../api/middleware/require-permission"
import { workspaceScope } from "../../api/middleware/workspace-scope"
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
	requirePermission("transaction.read"),
	billingController.transactions,
)

// What was actually paid. Behind `billing.manage` rather than `transaction.read`:
// an invoice carries a real amount and a link to a hosted receipt, which is a
// narrower audience than the credit ledger every administrator reads.
billingRoutes.get(
	"/:workspaceId/billing/payments",
	workspaceScope,
	requirePermission("billing.manage"),
	billingController.payments,
)

// Anything that can spend the workspace's money is owner or admin only.
billingRoutes.post(
	"/:workspaceId/billing/checkout",
	workspaceScope,
	requirePermission("billing.manage"),
	billingController.createCheckout,
)
billingRoutes.post(
	"/:workspaceId/billing/portal",
	workspaceScope,
	requirePermission("billing.manage"),
	billingController.createPortal,
)
billingRoutes.get(
	"/:workspaceId/billing/auto-reload",
	workspaceScope,
	requirePermission("billing.manage"),
	billingController.getAutoReload,
)
billingRoutes.put(
	"/:workspaceId/billing/auto-reload",
	workspaceScope,
	requirePermission("billing.manage"),
	billingController.updateAutoReload,
)
