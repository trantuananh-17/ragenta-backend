import { Hono } from "hono"

import { requireAdmin } from "../../api/middleware/require-admin"
import { requireAuth } from "../../api/middleware/session"
import type { AppEnv } from "../../api/types"
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
