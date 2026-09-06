import { getRedis } from "../../redis/client"
import { logger } from "../../shared/logger"

const log = logger.child({ module: "chat.stop" })

/**
 * "Stop generating", as a flag the streaming turn polls.
 *
 * The obvious implementation is for the client to abort its HTTP request, and
 * that is what this replaces. Aborting works — it stops the provider call
 * immediately — but it destroys the response stream at the same instant, so the
 * server has no way to tell the client "here is what you got, it is saved". The
 * partial answer then has to survive a race between the server writing it and
 * the client re-reading the thread, and when the race is lost the text the user
 * was reading disappears. Stopping is a normal thing to do; losing the answer is
 * not an acceptable outcome for it.
 *
 * So a stop is a *message*, not a disconnection. The client posts to the stop
 * endpoint, the generating request notices between two tokens, stops pulling
 * from the provider, saves what it has and sends its normal `done` frame. The
 * client's ordinary end-of-stream path then runs, unchanged, and the text is
 * already in the database by the time it refetches.
 *
 * **Redis rather than process memory** because the stop request will not
 * reliably land on the replica that is streaming. It is one key with a TTL, not
 * a queue: the flag only has to outlive one turn.
 *
 * **Scoped by workspace and conversation**, not just by message id, so a member
 * of one workspace cannot stop another's turn by guessing an id.
 */
const TTL_SECONDS = 300

function key(workspaceId: string, conversationId: string, messageId: string): string {
	return `chat:stop:${workspaceId}:${conversationId}:${messageId}`
}

export async function requestStop(
	workspaceId: string,
	conversationId: string,
	messageId: string,
): Promise<void> {
	await getRedis().set(key(workspaceId, conversationId, messageId), "1", "EX", TTL_SECONDS)
}

export async function isStopRequested(
	workspaceId: string,
	conversationId: string,
	messageId: string,
): Promise<boolean> {
	try {
		return (await getRedis().exists(key(workspaceId, conversationId, messageId))) === 1
	} catch (error) {
		// Redis being unreachable must not end a turn that is generating fine.
		// The cost of failing open is that one stop press does nothing and the
		// user presses it again; the cost of failing closed is every answer in
		// the product truncating whenever Redis blinks.
		log.warn("stop.check_failed", { messageId, error: String(error) })
		return false
	}
}

export async function clearStop(
	workspaceId: string,
	conversationId: string,
	messageId: string,
): Promise<void> {
	await getRedis()
		.del(key(workspaceId, conversationId, messageId))
		.catch(() => {
			// It expires on its own; a failed delete is not worth propagating.
		})
}
