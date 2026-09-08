import { getConnInfo } from "@hono/node-server/conninfo"
import { createMiddleware } from "hono/factory"

import { env } from "../../config/env"
import { getRedis } from "../../redis/client"
import { RateLimitedError } from "../../shared/errors"
import { clientAddress } from "../client-address"
import type { AppContext, AppEnv } from "../types"

/**
 * A fixed-window counter in Redis, in front of the two kinds of route where an
 * unlimited caller costs something real: the ones that let somebody guess a
 * password, and the ones that spend a workspace's credits on a provider call.
 *
 * Fixed window rather than a sliding log: a window boundary allows a burst of
 * up to twice the limit across two adjacent windows, and that is a price worth
 * paying for one `INCR` against a key that expires itself. Nothing here is
 * defending a hard quota — the credit ledger already does that, per call, and
 * this is what stops somebody reaching it in ten seconds.
 *
 * Redis is shared by the API and the worker, so the counter is shared by every
 * API replica the moment there is more than one.
 */
export interface RateLimitOptions {
	/** Namespaces the counter and names it in the log. */
	name: string
	limit: number
	windowSeconds: number
	/** Shown to the caller. Says what to do, not that a limit exists. */
	message?: string
}

export function rateLimit(options: RateLimitOptions) {
	const windowMs = options.windowSeconds * 1_000

	return createMiddleware<AppEnv>(async (c, next) => {
		if (!env.rateLimit.enabled) return next()

		const identity = identify(c)
		const bucket = Math.floor(Date.now() / windowMs)
		const key = `ratelimit:${options.name}:${bucket}:${identity}`
		const resetAt = (bucket + 1) * windowMs

		let used: number
		try {
			const redis = getRedis()
			used = await redis.incr(key)
			// Only the request that created the key sets its lifetime. Doing it
			// every time would push the expiry forward on every hit, and a counter
			// that never expires is a caller locked out permanently by their own
			// traffic.
			if (used === 1) await redis.pexpire(key, windowMs)
		} catch (error) {
			/*
				Fail open, loudly. Redis being unreachable already stops chat
				streaming and every job in the queue; adding "and nobody can sign
				in" to that list makes an outage worse, and a limiter is not the
				control that keeps a wrong password from working.
			*/
			c.get("logger").warn("ratelimit.unavailable", {
				limiter: options.name,
				error: error instanceof Error ? error.message : String(error),
			})
			return next()
		}

		const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1_000))

		c.header("RateLimit-Limit", String(options.limit))
		c.header("RateLimit-Remaining", String(Math.max(0, options.limit - used)))
		c.header("RateLimit-Reset", String(retryAfterSeconds))

		if (used > options.limit) {
			c.get("logger").warn("ratelimit.exceeded", {
				limiter: options.name,
				limit: options.limit,
				windowSeconds: options.windowSeconds,
			})
			c.header("Retry-After", String(retryAfterSeconds))
			throw new RateLimitedError(retryAfterSeconds, options.message)
		}

		return next()
	})
}

/**
 * Who the window belongs to.
 *
 * A signed-in caller is counted as themselves, so one person on a shared office
 * address cannot exhaust everybody else's quota — which is the failure mode of
 * counting an authenticated route by address. An anonymous one is counted by
 * address, because on a sign-in route the identity is the thing being guessed.
 *
 * The socket peer is the last resort and deliberately collapses to one bucket:
 * behind nginx neither header is ever absent, so a request with no address is
 * one arriving by a route that is not supposed to exist, and sharing a counter
 * is the right way to treat it.
 */
function identify(c: AppContext): string {
	const user = c.get("user")
	if (user) return `user:${user.id}`

	const address = clientAddress(c.req.header("x-real-ip"), c.req.header("x-forwarded-for"))
	if (address) return `ip:${address}`

	return `peer:${getConnInfo(c).remote.address ?? "unknown"}`
}
