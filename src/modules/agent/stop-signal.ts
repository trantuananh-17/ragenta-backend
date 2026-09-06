import { getRedis } from "../../redis/client"
import { logger } from "../../shared/logger"

const log = logger.child({ module: "agent.stop" })

/**
 * "Stop this run", as a flag the streaming run polls — the same mechanism a chat
 * turn uses (ADR-028), for the same reason: aborting the HTTP request destroys
 * the response stream at the instant it stops the provider, so the server has no
 * way to tell the client what it saved.
 *
 * Keyed by run rather than by message. A run id exists in the database before a
 * token does, so unlike chat there is nothing to authorise beyond the run's own
 * workspace — but the workspace stays in the key anyway, so one workspace cannot
 * stop another's run by guessing an id.
 */
const TTL_SECONDS = 900

function key(workspaceId: string, runId: string): string {
	return `agent:stop:${workspaceId}:${runId}`
}

export async function requestStop(workspaceId: string, runId: string): Promise<void> {
	await getRedis().set(key(workspaceId, runId), "1", "EX", TTL_SECONDS)
}

export async function isStopRequested(workspaceId: string, runId: string): Promise<boolean> {
	try {
		return (await getRedis().exists(key(workspaceId, runId))) === 1
	} catch (error) {
		// Redis being unreachable must not end a run that is generating fine. One
		// missed stop press costs a button press; failing closed would truncate
		// every answer in the product whenever Redis blinks.
		log.warn("stop.check_failed", { runId, error: String(error) })
		return false
	}
}

export async function clearStop(workspaceId: string, runId: string): Promise<void> {
	await getRedis()
		.del(key(workspaceId, runId))
		.catch(() => {
			// It expires on its own; a failed delete is not worth propagating.
		})
}
