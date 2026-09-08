/**
 * Domain errors. Services throw these; the API error handler is the only place
 * that turns them into HTTP. Nothing below the API layer imports Hono or knows
 * about status codes beyond the one carried here.
 */
export class AppError extends Error {
	readonly status: number
	readonly code: string
	readonly details?: unknown

	constructor(code: string, message: string, status: number, details?: unknown) {
		super(message)
		this.name = new.target.name
		this.code = code
		this.status = status
		this.details = details
	}
}

export class UnauthorizedError extends AppError {
	constructor(message = "Authentication required.") {
		super("UNAUTHORIZED", message, 401)
	}
}

export class ForbiddenError extends AppError {
	constructor(message = "You do not have access to this resource.") {
		super("FORBIDDEN", message, 403)
	}
}

export class NotFoundError extends AppError {
	constructor(resource: string) {
		super("NOT_FOUND", `${resource} not found.`, 404)
	}
}

export class ConflictError extends AppError {
	constructor(message: string, details?: unknown) {
		super("CONFLICT", message, 409, details)
	}
}

export class ValidationError extends AppError {
	constructor(message: string, details?: unknown) {
		super("VALIDATION_ERROR", message, 422, details)
	}
}

/**
 * Too many requests in the window. `retryAfterSeconds` is carried here rather
 * than set as a header at the throw site, because the API error handler is the
 * only place that turns a domain error into HTTP and a service that has to
 * reach for `c.header` is a service that knows about Hono.
 */
export class RateLimitedError extends AppError {
	readonly retryAfterSeconds: number

	constructor(retryAfterSeconds: number, message = "Too many requests. Try again shortly.") {
		super("RATE_LIMITED", message, 429)
		this.retryAfterSeconds = retryAfterSeconds
	}
}

/** Plan/quota refusals — the caller is authenticated and allowed, but out of entitlement. */
export class EntitlementError extends AppError {
	constructor(code: string, message: string, details?: unknown) {
		super(code, message, 402, details)
	}
}

export function isAppError(error: unknown): error is AppError {
	return error instanceof AppError
}
