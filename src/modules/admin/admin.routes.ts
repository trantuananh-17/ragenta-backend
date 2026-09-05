import { Hono } from "hono"

import { requireAdmin } from "../../api/middleware/require-admin"
import { requireAuth } from "../../api/middleware/session"
import type { AppEnv } from "../../api/types"
import { promoController } from "../promo/promo.controller"
import { providerController } from "../provider/provider.controller"
import { adminController } from "./admin.controller"

/**
 * Platform administration. Cross-tenant by definition, so the gate is applied
 * once to the whole router rather than per route — there is no such thing as a
 * public endpoint under here.
 */
export const adminRoutes = new Hono<AppEnv>()

adminRoutes.use("*", requireAuth, requireAdmin)

adminRoutes.get("/users", adminController.listUsers)
adminRoutes.get("/workspaces", adminController.listWorkspaces)
adminRoutes.get("/workspaces/:workspaceId", adminController.getWorkspace)
adminRoutes.post("/workspaces/:workspaceId/credits", adminController.adjustCredits)
adminRoutes.put("/workspaces/:workspaceId/plan", adminController.setPlan)
adminRoutes.get("/audit-log", adminController.listAuditLog)

// Promo codes are cross-tenant objects — one code is redeemable by any
// workspace — so they belong to the platform admin surface, not to a workspace.
adminRoutes.get("/promo-codes", promoController.list)
adminRoutes.post("/promo-codes", promoController.create)
adminRoutes.patch("/promo-codes/:promoCodeId", promoController.update)
adminRoutes.delete("/promo-codes/:promoCodeId", promoController.remove)
adminRoutes.get("/promo-codes/:promoCodeId/redemptions", promoController.listRedemptions)

// Model providers, their credentials and the catalogue. Platform-level: Ragenta
// pays for inference, so a workspace never supplies a key and never edits this.
adminRoutes.get("/providers", providerController.list)
adminRoutes.put("/providers/:provider/credential", providerController.saveCredential)
adminRoutes.delete("/providers/:provider/credential", providerController.removeCredential)
adminRoutes.post("/providers/:provider/check", providerController.checkCredential)
adminRoutes.post("/models", providerController.upsertModel)
adminRoutes.patch("/providers/:provider/models/:model", providerController.patchModel)
adminRoutes.delete("/providers/:provider/models/:model", providerController.removeModel)
adminRoutes.get("/settings/models", providerController.getDefaults)
adminRoutes.put("/settings/models", providerController.setDefaults)
