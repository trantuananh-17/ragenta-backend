import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requirePermission } from "../../api/middleware/require-permission"
import { workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { attachmentController } from "./attachment.controller"

/**
 * Attachments are workspace-visible for the same reason conversations are: an
 * image someone asked a question about is part of the thread, and a thread
 * nobody else can read is a thread nobody else can help with.
 *
 * Uploading and deleting are writes, and the image an upload produces is what a
 * vision call is later billed for, so `viewer` can do neither.
 */
export const attachmentRoutes = new Hono<AppEnv>()

attachmentRoutes.use("*", requireAuth)


attachmentRoutes.post(
	"/:workspaceId/attachments",
	workspaceScope,
	requirePermission("attachment.create"),
	attachmentController.upload,
)
attachmentRoutes.get(
	"/:workspaceId/attachments/:attachmentId",
	workspaceScope,
	attachmentController.get,
)
attachmentRoutes.get(
	"/:workspaceId/attachments/:attachmentId/content",
	workspaceScope,
	attachmentController.content,
)
attachmentRoutes.delete(
	"/:workspaceId/attachments/:attachmentId",
	workspaceScope,
	requirePermission("attachment.delete"),
	attachmentController.remove,
)
