import { randomUUID } from "node:crypto"
import { createMiddleware } from "hono/factory"

import { logger } from "../../shared/logger"
import type { AppEnv } from "../types"

/**
 * One correlation id per request, echoed back so a client can quote it in a bug
 * report, and bound into the logger every handler below reads.
 */
export const requestContext = createMiddleware<AppEnv>(async (c, next) => {
	const requestId = c.req.header("x-request-id") ?? randomUUID()
	const requestLogger = logger.child({
		requestId,
		method: c.req.method,
		path: c.req.path,
	})

	c.set("requestId", requestId)
	c.set("logger", requestLogger)
	c.header("x-request-id", requestId)

	const startedAt = Date.now()
	await next()
	requestLogger.info("request.completed", {
		status: c.res.status,
		durationMs: Date.now() - startedAt,
	})
})
