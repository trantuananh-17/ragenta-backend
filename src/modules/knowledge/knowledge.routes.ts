import { Hono } from "hono"

import { requirePermission } from "../../api/middleware/require-permission"
import {
	requireResolvedResourcePermission,
	requireResourcePermission,
} from "../../api/middleware/require-resource-permission"
import { requireAuth } from "../../api/middleware/session"
import { workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { knowledgeController } from "./knowledge.controller"
import { knowledgeRepository } from "./knowledge.repository"

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
 * Documents inherit their knowledge base's grants, and their routes name only the
 * document — so the base is resolved before the permission is asked. Without this
 * a denied base could still be read one document at a time.
 */
function documentGuard(key: "document.read" | "document.update" | "document.delete") {
	return requireResolvedResourcePermission(
		key,
		"knowledgeBase",
		"documentId",
		async (workspaceId, documentId) => {
			const document = await knowledgeRepository.findDocument(workspaceId, documentId)
			return document?.knowledgeBaseId
		},
	)
}

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
	requireResourcePermission("knowledgeBase.read", "knowledgeBase", "baseId"),
	knowledgeController.getBase,
)
knowledgeRoutes.patch(
	"/:workspaceId/knowledge-bases/:baseId",
	workspaceScope,
	requireResourcePermission("knowledgeBase.update", "knowledgeBase", "baseId"),
	knowledgeController.updateBase,
)
knowledgeRoutes.delete(
	"/:workspaceId/knowledge-bases/:baseId",
	workspaceScope,
	requireResourcePermission("knowledgeBase.delete", "knowledgeBase", "baseId"),
	knowledgeController.deleteBase,
)

knowledgeRoutes.get(
	"/:workspaceId/knowledge-bases/:baseId/documents",
	workspaceScope,
	requireResourcePermission("document.read", "knowledgeBase", "baseId"),
	knowledgeController.listDocuments,
)
knowledgeRoutes.post(
	"/:workspaceId/knowledge-bases/:baseId/documents",
	workspaceScope,
	requireResourcePermission("document.create", "knowledgeBase", "baseId"),
	knowledgeController.uploadDocument,
)

knowledgeRoutes.get(
	"/:workspaceId/documents/:documentId",
	workspaceScope,
	documentGuard("document.read"),
	knowledgeController.getDocument,
)
knowledgeRoutes.get(
	"/:workspaceId/documents/:documentId/download",
	workspaceScope,
	documentGuard("document.read"),
	knowledgeController.downloadDocument,
)
knowledgeRoutes.get(
	"/:workspaceId/documents/:documentId/chunks",
	workspaceScope,
	documentGuard("document.read"),
	knowledgeController.listChunks,
)
knowledgeRoutes.get(
	"/:workspaceId/documents/:documentId/tasks",
	workspaceScope,
	documentGuard("document.read"),
	knowledgeController.listTasks,
)
knowledgeRoutes.post(
	"/:workspaceId/documents/:documentId/reindex",
	workspaceScope,
	documentGuard("document.update"),
	knowledgeController.reindexDocument,
)
knowledgeRoutes.post(
	"/:workspaceId/documents/:documentId/cancel",
	workspaceScope,
	documentGuard("document.update"),
	knowledgeController.cancelDocument,
)
knowledgeRoutes.delete(
	"/:workspaceId/documents/:documentId",
	workspaceScope,
	documentGuard("document.delete"),
	knowledgeController.deleteDocument,
)
