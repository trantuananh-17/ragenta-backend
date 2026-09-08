import { Hono } from "hono"

import {
	requireAdminConsole,
	requirePlatformPermission,
} from "../../api/middleware/require-admin"
import { requireAuth } from "../../api/middleware/session"
import type { AppEnv } from "../../api/types"
import { promoController } from "../promo/promo.controller"
import { integrationController } from "../integration/integration.controller"
import { providerController } from "../provider/provider.controller"
import { adminController } from "./admin.controller"
import { speechAdminController } from "../speech/speech.admin.controller"

/**
 * Platform administration. Cross-tenant by definition, so the console gate is
 * applied once to the whole router — there is no such thing as a public endpoint
 * under here — and each route then names the permission it needs.
 *
 * Two gates rather than one because they answer different questions: whether
 * somebody may open the console at all, and whether this particular thing is
 * theirs to do. Reading the audit log and adjusting a workspace's credits were
 * the same privilege until this (ADR-046).
 */
export const adminRoutes = new Hono<AppEnv>()

adminRoutes.use("*", requireAuth, requireAdminConsole)

adminRoutes.get("/users", requirePlatformPermission("admin.user.read"), adminController.listUsers)
adminRoutes.get(
	"/workspaces",
	requirePlatformPermission("admin.workspace.read"),
	adminController.listWorkspaces,
)
adminRoutes.get(
	"/workspaces/:workspaceId",
	requirePlatformPermission("admin.workspace.read"),
	adminController.getWorkspace,
)
adminRoutes.post(
	"/workspaces/:workspaceId/credits",
	requirePlatformPermission("admin.credit.adjust"),
	adminController.adjustCredits,
)
adminRoutes.put(
	"/workspaces/:workspaceId/plan",
	requirePlatformPermission("admin.workspace.manage"),
	adminController.setPlan,
)
adminRoutes.get(
	"/audit-log",
	requirePlatformPermission("admin.audit.read"),
	adminController.listAuditLog,
)

// Promo codes are cross-tenant objects — one code is redeemable by any
// workspace — so they belong to the platform admin surface, not to a workspace.
adminRoutes.get("/promo-codes", requirePlatformPermission("admin.promo.read"), promoController.list)
adminRoutes.post(
	"/promo-codes",
	requirePlatformPermission("admin.promo.manage"),
	promoController.create,
)
adminRoutes.patch(
	"/promo-codes/:promoCodeId",
	requirePlatformPermission("admin.promo.manage"),
	promoController.update,
)
adminRoutes.delete(
	"/promo-codes/:promoCodeId",
	requirePlatformPermission("admin.promo.manage"),
	promoController.remove,
)
adminRoutes.get(
	"/promo-codes/:promoCodeId/redemptions",
	requirePlatformPermission("admin.promo.read"),
	promoController.listRedemptions,
)

// Model providers, their credentials and the catalogue. Platform-level: Ragenta
// pays for inference, so a workspace never supplies a key and never edits this.
adminRoutes.get(
	"/providers",
	requirePlatformPermission("admin.provider.read"),
	providerController.list,
)
adminRoutes.put(
	"/providers/:provider/credential",
	requirePlatformPermission("admin.provider.manage"),
	providerController.saveCredential,
)
adminRoutes.delete(
	"/providers/:provider/credential",
	requirePlatformPermission("admin.provider.manage"),
	providerController.removeCredential,
)
adminRoutes.post(
	"/providers/:provider/check",
	requirePlatformPermission("admin.provider.manage"),
	providerController.checkCredential,
)
adminRoutes.post(
	"/providers/:provider/models/import",
	requirePlatformPermission("admin.model.manage"),
	providerController.importModels,
)
adminRoutes.post(
	"/models",
	requirePlatformPermission("admin.model.manage"),
	providerController.upsertModel,
)
adminRoutes.patch(
	"/providers/:provider/models/:model",
	requirePlatformPermission("admin.model.manage"),
	providerController.patchModel,
)
adminRoutes.delete(
	"/providers/:provider/models/:model",
	requirePlatformPermission("admin.model.manage"),
	providerController.removeModel,
)
// Outside systems an agent may act on. Platform-level like the model providers,
// and for the same reason: the deployment owns the credential, and the allowlist
// on each row is what bounds every agent in it.
adminRoutes.get(
	"/integrations",
	requirePlatformPermission("admin.integration.read"),
	integrationController.list,
)
adminRoutes.get(
	"/integrations/:integrationId",
	requirePlatformPermission("admin.integration.read"),
	integrationController.get,
)
adminRoutes.put(
	"/integrations/:integrationId",
	requirePlatformPermission("admin.integration.manage"),
	integrationController.save,
)
adminRoutes.delete(
	"/integrations/:integrationId",
	requirePlatformPermission("admin.integration.manage"),
	integrationController.remove,
)
adminRoutes.post(
	"/integrations/:integrationId/check",
	requirePlatformPermission("admin.integration.manage"),
	integrationController.check,
)

// Transcription and synthesis. Separate from the model providers because they
// are bought separately and configured separately: a deployment can transcribe
// through one gateway and speak Vietnamese through a self-hosted container, and
// neither half is a chat provider anyone picks a model from.
adminRoutes.get(
	"/speech",
	requirePlatformPermission("admin.speech.read"),
	speechAdminController.get,
)
adminRoutes.put(
	"/speech/:capability",
	requirePlatformPermission("admin.speech.manage"),
	speechAdminController.save,
)
adminRoutes.delete(
	"/speech/:capability",
	requirePlatformPermission("admin.speech.manage"),
	speechAdminController.remove,
)
adminRoutes.post(
	"/speech/:capability/check",
	requirePlatformPermission("admin.speech.manage"),
	speechAdminController.check,
)

adminRoutes.get(
	"/settings/models",
	requirePlatformPermission("admin.model.read"),
	providerController.getDefaults,
)
adminRoutes.put(
	"/settings/models",
	requirePlatformPermission("admin.model.manage"),
	providerController.setDefaults,
)
// Which models each plan may offer, and what it runs by default. One plan per
// request: the screen edits one at a time, and a whole-map PUT would let a stale
// tab overwrite a plan the operator never looked at.
adminRoutes.get(
	"/settings/model-access",
	requirePlatformPermission("admin.model.read"),
	providerController.getPlanModelAccess,
)
adminRoutes.put(
	"/settings/model-access/:plan",
	requirePlatformPermission("admin.model.manage"),
	providerController.setPlanModelAccess,
)
