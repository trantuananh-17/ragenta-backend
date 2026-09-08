import { Hono } from "hono"

import { rateLimit } from "../../api/middleware/rate-limit"
import { requireAuth } from "../../api/middleware/session"
import { requireWorkspaceRole, workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { chatController } from "./chat.controller"

/**
 * Conversations are workspace-visible, not private to their author: an answer
 * grounded in the workspace's documents is workspace knowledge, and a support
 * question about one is unanswerable if nobody else can see it.
 *
 * Sending a message spends credits, so `viewer` cannot.
 */
export const chatRoutes = new Hono<AppEnv>()

chatRoutes.use("*", requireAuth)

const contributor = requireWorkspaceRole("owner", "admin", "member")

/**
 * Sending is the expensive verb here: it retrieves, it calls a provider, and it
 * bills. The ceiling is far above what a person types and far below what a
 * script can spend — the credit ledger is what actually caps the money, and
 * this is what stops a loop reaching that cap in seconds.
 */
const sending = rateLimit({
	name: "chat.send",
	limit: 30,
	windowSeconds: 60,
	message: "Too many messages in a row. Wait a moment before sending another.",
})

chatRoutes.get("/:workspaceId/conversations", workspaceScope, chatController.listConversations)
chatRoutes.post(
	"/:workspaceId/conversations",
	workspaceScope,
	contributor,
	chatController.createConversation,
)
chatRoutes.get(
	"/:workspaceId/conversations/:conversationId",
	workspaceScope,
	chatController.getConversation,
)
chatRoutes.patch(
	"/:workspaceId/conversations/:conversationId",
	workspaceScope,
	contributor,
	chatController.updateConversation,
)
chatRoutes.delete(
	"/:workspaceId/conversations/:conversationId",
	workspaceScope,
	contributor,
	chatController.deleteConversation,
)
chatRoutes.get(
	"/:workspaceId/conversations/:conversationId/messages",
	workspaceScope,
	chatController.listMessages,
)
chatRoutes.post(
	"/:workspaceId/conversations/:conversationId/messages",
	workspaceScope,
	contributor,
	sending,
	chatController.sendMessage,
)
chatRoutes.post(
	"/:workspaceId/conversations/:conversationId/messages/stream",
	workspaceScope,
	contributor,
	sending,
	chatController.streamMessage,
)
chatRoutes.post(
	"/:workspaceId/conversations/:conversationId/messages/:messageId/stop",
	workspaceScope,
	contributor,
	chatController.stopMessage,
)
