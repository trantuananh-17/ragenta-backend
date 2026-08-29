import { createMiddleware } from "hono/factory"

import { auth } from "../../auth/auth"
import { UnauthorizedError } from "../../shared/errors"
import type { AppEnv } from "../types"

/**
 * Resolves the caller from the request's own credentials — session cookie or
 * bearer token — and never from anything the client claims in a body or query
 * parameter. Runs on every route so handlers can log the actor even when the
 * endpoint is public.
 */
export const attachSession = createMiddleware<AppEnv>(async (c, next) => {
	const result = await auth.api.getSession({ headers: c.req.raw.headers })
	if (result) {
		c.set("user", result.user)
		c.set("session", result.session)
		c.set("logger", c.get("logger").child({ userId: result.user.id }))
	}
	await next()
})

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
	const user = c.get("user")
	if (!user) throw new UnauthorizedError()
	if (user.banned) throw new UnauthorizedError("This account is suspended.")
	await next()
})
