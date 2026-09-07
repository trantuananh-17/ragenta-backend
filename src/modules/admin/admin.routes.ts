import { Hono } from "hono"

import { requireAdmin } from "../../api/middleware/require-admin"
import { requireAuth } from "../../api/middleware/session"
import type { AppEnv } from "../../api/types"
import { promoController } from "../promo/promo.controller"
import { integrationController } from "../integration/integration.controller"
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
adminRoutes.post("/providers/:provider/models/import", providerController.importModels)
adminRoutes.post("/models", providerController.upsertModel)
adminRoutes.patch("/providers/:provider/models/:model", providerController.patchModel)
adminRoutes.delete("/providers/:provider/models/:model", providerController.removeModel)
// Outside systems an agent may act on. Platform-level like the model providers,
// and for the same reason: the deployment owns the credential, and the allowlist
// on each row is what bounds every agent in it.
adminRoutes.get("/integrations", integrationController.list)
adminRoutes.get("/integrations/:integrationId", integrationController.get)
adminRoutes.put("/integrations/:integrationId", integrationController.save)
adminRoutes.delete("/integrations/:integrationId", integrationController.remove)
adminRoutes.post("/integrations/:integrationId/check", integrationController.check)

adminRoutes.get("/settings/models", providerController.getDefaults)
adminRoutes.put("/settings/models", providerController.setDefaults)
// Which models each plan may offer, and what it runs by default. One plan per
// request: the screen edits one at a time, and a whole-map PUT would let a stale
// tab overwrite a plan the operator never looked at.
adminRoutes.get("/settings/model-access", providerController.getPlanModelAccess)
adminRoutes.put("/settings/model-access/:plan", providerController.setPlanModelAccess)
