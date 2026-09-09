import { Hono } from "hono"

import {
	requireAdminConsole,
	requirePlatformPermission,
} from "../../api/middleware/require-admin"
import { requireAuth } from "../../api/middleware/session"
import type { AppEnv } from "../../api/types"
import { revenueController } from "../billing/revenue.controller"
import { promoController } from "../promo/promo.controller"
import { integrationController } from "../integration/integration.controller"
import { providerController } from "../provider/provider.controller"
import { mcpController } from "../mcp/mcp.controller"
import { oauthController } from "../oauth/oauth.controller"
import { observabilityController } from "../observability/observability.controller"
import { rbacController } from "../rbac/rbac.controller"
import { platformUsageController } from "../usage/usage.controller"
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

// Roles and permissions. The catalogue is read-only — it is the release's list of
// what can be checked — and everything else composes and hands out what is in it.
adminRoutes.get(
	"/permissions",
	requirePlatformPermission("admin.role.read"),
	rbacController.listPermissions,
)
adminRoutes.get("/roles", requirePlatformPermission("admin.role.read"), rbacController.listRoles)
adminRoutes.post(
	"/roles",
	requirePlatformPermission("admin.role.manage"),
	rbacController.createRole,
)
adminRoutes.get(
	"/roles/:roleId",
	requirePlatformPermission("admin.role.read"),
	rbacController.getRole,
)
adminRoutes.patch(
	"/roles/:roleId",
	requirePlatformPermission("admin.role.manage"),
	rbacController.updateRole,
)
adminRoutes.delete(
	"/roles/:roleId",
	requirePlatformPermission("admin.role.manage"),
	rbacController.deleteRole,
)

adminRoutes.get(
	"/users/:userId/platform-roles",
	requirePlatformPermission("admin.role.read"),
	rbacController.listPlatformRoles,
)
adminRoutes.put(
	"/users/:userId/platform-roles",
	requirePlatformPermission("admin.role.manage"),
	rbacController.setPlatformRoles,
)

// The admin API could read a workspace but not administer its members. It can
// now change what one may do, which is the point of the whole model.
adminRoutes.get(
	"/workspaces/:workspaceId/members",
	requirePlatformPermission("admin.workspace.read"),
	adminController.listWorkspaceMembers,
)
adminRoutes.get(
	"/workspaces/:workspaceId/members/:memberId/roles",
	requirePlatformPermission("admin.role.read"),
	rbacController.listMemberRoles,
)
adminRoutes.put(
	"/workspaces/:workspaceId/members/:memberId/roles",
	requirePlatformPermission("admin.role.manage"),
	rbacController.setMemberRoles,
)

/**
 * What the deployment earns against what it spends.
 *
 * Behind `admin.usage.read` like the spend report beside it: `finance` holds it
 * and `support` deliberately does not — reproducing a customer's problem does not
 * need the margin (ADR-051).
 */
adminRoutes.get(
	"/revenue",
	requirePlatformPermission("admin.usage.read"),
	revenueController.overview,
)

// What the platform has spent, and on which model. Cross-tenant by definition,
// and behind its own permission: `support` reproduces customer problems and does
// not need the commercial number (ADR-051).
adminRoutes.get(
	"/usage",
	requirePlatformPermission("admin.usage.read"),
	platformUsageController.overview,
)
adminRoutes.get(
	"/usage/models",
	requirePlatformPermission("admin.usage.read"),
	platformUsageController.byModel,
)
adminRoutes.get(
	"/usage/workspaces",
	requirePlatformPermission("admin.usage.read"),
	platformUsageController.byWorkspace,
)

// MCP servers every workspace may name. Deployment-wide like the model
// providers, and for the same reason: the deployment owns the credential.
adminRoutes.get(
	"/mcp-servers",
	requirePlatformPermission("admin.mcp.read"),
	mcpController.listPlatform,
)
adminRoutes.put(
	"/mcp-servers",
	requirePlatformPermission("admin.mcp.manage"),
	mcpController.savePlatform,
)
adminRoutes.delete(
	"/mcp-servers/:serverId",
	requirePlatformPermission("admin.mcp.manage"),
	mcpController.removePlatform,
)
adminRoutes.post(
	"/mcp-servers/:serverId/check",
	requirePlatformPermission("admin.mcp.manage"),
	mcpController.checkPlatform,
)

// The deployment's own OAuth apps. Ragenta registers them, so the client id and
// secret are platform configuration rather than anything a workspace supplies.
adminRoutes.get(
	"/oauth-providers",
	requirePlatformPermission("admin.oauth.read"),
	oauthController.listForAdmin,
)
adminRoutes.put(
	"/oauth-providers/:provider",
	requirePlatformPermission("admin.oauth.manage"),
	oauthController.saveClient,
)

// Provider calls that failed. Beside the spend deliberately: "what is this
// costing" and "what is failing" are read at the same moment (ADR-063).
adminRoutes.get(
	"/provider-errors",
	requirePlatformPermission("admin.errors.read"),
	observabilityController.listPlatformErrors,
)
