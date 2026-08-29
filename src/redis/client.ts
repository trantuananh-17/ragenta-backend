import { Redis } from "ioredis"

import { env } from "../config/env"

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connections it blocks on,
 * otherwise a worker that loses Redis briefly dies instead of reconnecting.
 */
function createConnection() {
	return new Redis(env.redisUrl, { maxRetriesPerRequest: null })
}

let shared: Redis | undefined

/** Shared connection for cache and rate-limit style work. */
export function getRedis(): Redis {
	if (!shared) shared = createConnection()
	return shared
}

/** A dedicated connection — BullMQ queues and workers must not share one. */
export function createRedisConnection(): Redis {
	return createConnection()
}

export async function closeRedis(): Promise<void> {
	await shared?.quit()
	shared = undefined
}
