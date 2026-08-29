import { createMiddleware } from "hono/factory"

import { env } from "../../config/env"
import { ForbiddenError } from "../../shared/errors"
import type { AppEnv } from "../types"
import { requireUser } from "../types"

/**
 * Platform administration gate — a different question from workspace roles.
 * Enforced here, on the server, on every admin request: the admin frontend's
 * route guards are UX only.
 */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
	const user = requireUser(c)

	const isListedAdmin = env.adminUserIds.includes(user.id)
	const hasAdminRole = (user.role ?? "")
		.split(",")
		.map((role) => role.trim())
		.includes("admin")

	if (!isListedAdmin && !hasAdminRole) {
		throw new ForbiddenError("Administrator access required.")
	}

	await next()
})
