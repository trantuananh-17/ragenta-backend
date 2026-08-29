import { APIError } from "better-auth/api"
import type { ErrorHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { ZodError } from "zod"

import { isAppError } from "../../shared/errors"
import { logger } from "../../shared/logger"
import type { AppEnv } from "../types"

/** Better Auth reports its status as a name; map the ones its handlers raise. */
const BETTER_AUTH_STATUS: Record<string, number> = {
	BAD_REQUEST: 400,
	UNAUTHORIZED: 401,
	PAYMENT_REQUIRED: 402,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	CONFLICT: 409,
	UNPROCESSABLE_ENTITY: 422,
	TOO_MANY_REQUESTS: 429,
	INTERNAL_SERVER_ERROR: 500,
}

interface ErrorBody {
	error: {
		code: string
		message: string
		details?: unknown
	}
	requestId: string
}

/**
 * The single place domain errors become HTTP. Anything unrecognised is a 500
 * with a generic message — the detail goes to the log, never to the client,
 * because unexpected errors carry query fragments and identifiers.
 */
export const errorHandler: ErrorHandler<AppEnv> = (error, c) => {
	const requestId = c.get("requestId") ?? "unknown"
	const log = c.get("logger") ?? logger

	if (isAppError(error)) {
		log.warn("request.failed", { code: error.code, status: error.status })
		return c.json<ErrorBody>(
			{
				error: { code: error.code, message: error.message, details: error.details },
				requestId,
			},
			error.status as 400,
		)
	}

	if (error instanceof ZodError) {
		return c.json<ErrorBody>(
			{
				error: {
					code: "VALIDATION_ERROR",
					message: "The request payload is invalid.",
					details: error.issues.map((issue) => ({
						path: issue.path.join("."),
						message: issue.message,
					})),
				},
				requestId,
			},
			422,
		)
	}

	if (error instanceof APIError) {
		const status = BETTER_AUTH_STATUS[String(error.status)] ?? 400
		const body = error.body as { code?: string; message?: string } | undefined
		log.warn("request.failed", { code: body?.code, status })
		return c.json<ErrorBody>(
			{
				error: {
					code: body?.code ?? String(error.status),
					message: body?.message ?? error.message,
				},
				requestId,
			},
			status as 400,
		)
	}

	if (error instanceof HTTPException) {
		return c.json<ErrorBody>(
			{ error: { code: "HTTP_ERROR", message: error.message }, requestId },
			error.status,
		)
	}

	log.error("request.unhandled", error)
	return c.json<ErrorBody>(
		{ error: { code: "INTERNAL_ERROR", message: "Something went wrong." }, requestId },
		500,
	)
}
