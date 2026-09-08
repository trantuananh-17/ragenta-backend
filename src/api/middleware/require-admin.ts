import { createMiddleware } from "hono/factory"

import type { PlatformPermissionKey } from "../../auth/permissions"
import { env } from "../../config/env"
import { isBreakGlassAdmin } from "../../modules/rbac/break-glass"
import { permissionService } from "../../modules/rbac/permission.service"
import { ForbiddenError } from "../../shared/errors"
import type { AppEnv } from "../types"
import { requireUser } from "../types"

/**
 * Platform administration — a different question from workspace permissions, and
 * no longer one boolean.
 *
 * `requireAdmin` used to admit anybody with `role: admin` to everything in the
 * console, so reading the audit log and adjusting a workspace's credits were the
 * same privilege. Each route now names what it needs, and the roles that hold
 * those permissions are rows (ADR-046).
 *
 * Enforced here, on the server, on every request: the admin console's route
 * guards are UX only.
 */
export function requirePlatformPermission(key: PlatformPermissionKey) {
	return createMiddleware<AppEnv>(async (c, next) => {
		const user = requireUser(c)

		// The break-glass grant is computed from the live session rather than
		// cached with the rest, so revoking somebody's `admin` role takes effect on
		// their next request instead of when a cache entry expires.
		if (isBreakGlassAdmin(user, env.adminUserIds)) {
			await next()
			return
		}

		const held = await permissionService.forPlatformUser(user.id)
		if (!held.has(key)) {
			throw new ForbiddenError(`This action requires the ${key} permission.`)
		}

		await next()
	})
}

/** The gate on the console as a whole. Every admin route carries its own on top. */
export const requireAdminConsole = requirePlatformPermission("admin.console.access")
