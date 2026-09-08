import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requirePermission } from "../../api/middleware/require-permission"
import { workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { knowledgeController } from "./knowledge.controller"

/**
 * Reading a knowledge base is open to any member — it is what they chat against.
 * Writing costs credits (every upload is an embedding bill) and changes what
 * every answer in the workspace is grounded in, so it is owner/admin/member and
 * not `viewer`.
 *
 * Deleting a knowledge base destroys work nobody can recover, so it is narrower
 * still.
 */
export const knowledgeRoutes = new Hono<AppEnv>()

knowledgeRoutes.use("*", requireAuth)


/**
 * The chunking strategies this deployment offers. Workspace-scoped only so it
 * sits under the same prefix as everything else — the list is the same for every
 * workspace, because it is a property of the build.
 */
knowledgeRoutes.get(
	"/:workspaceId/knowledge-bases/chunking-methods",
	workspaceScope,
	knowledgeController.listParsers,
)

knowledgeRoutes.get(
	"/:workspaceId/knowledge-bases",
	workspaceScope,
	knowledgeController.listBases,
)
knowledgeRoutes.post(
	"/:workspaceId/knowledge-bases",
	workspaceScope,
	requirePermission("knowledgeBase.create"),
	knowledgeController.createBase,
)
knowledgeRoutes.get(
	"/:workspaceId/knowledge-bases/:baseId",
	workspaceScope,
	knowledgeController.getBase,
)
knowledgeRoutes.patch(
	"/:workspaceId/knowledge-bases/:baseId",
	workspaceScope,
	requirePermission("knowledgeBase.update"),
	knowledgeController.updateBase,
)
knowledgeRoutes.delete(
	"/:workspaceId/knowledge-bases/:baseId",
	workspaceScope,
	requirePermission("knowledgeBase.delete"),
	knowledgeController.deleteBase,
)

knowledgeRoutes.get(
	"/:workspaceId/knowledge-bases/:baseId/documents",
	workspaceScope,
	knowledgeController.listDocuments,
)
knowledgeRoutes.post(
	"/:workspaceId/knowledge-bases/:baseId/documents",
	workspaceScope,
	requirePermission("document.create"),
	knowledgeController.uploadDocument,
)

knowledgeRoutes.get(
	"/:workspaceId/documents/:documentId",
	workspaceScope,
	knowledgeController.getDocument,
)
knowledgeRoutes.get(
	"/:workspaceId/documents/:documentId/download",
	workspaceScope,
	knowledgeController.downloadDocument,
)
knowledgeRoutes.get(
	"/:workspaceId/documents/:documentId/chunks",
	workspaceScope,
	knowledgeController.listChunks,
)
knowledgeRoutes.get(
	"/:workspaceId/documents/:documentId/tasks",
	workspaceScope,
	knowledgeController.listTasks,
)
knowledgeRoutes.post(
	"/:workspaceId/documents/:documentId/reindex",
	workspaceScope,
	requirePermission("document.update"),
	knowledgeController.reindexDocument,
)
knowledgeRoutes.post(
	"/:workspaceId/documents/:documentId/cancel",
	workspaceScope,
	requirePermission("document.update"),
	knowledgeController.cancelDocument,
)
knowledgeRoutes.delete(
	"/:workspaceId/documents/:documentId",
	workspaceScope,
	requirePermission("document.delete"),
	knowledgeController.deleteDocument,
)
