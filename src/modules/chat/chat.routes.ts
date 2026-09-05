import { Hono } from "hono"

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
	chatController.sendMessage,
)
chatRoutes.post(
	"/:workspaceId/conversations/:conversationId/messages/stream",
	workspaceScope,
	contributor,
	chatController.streamMessage,
)
