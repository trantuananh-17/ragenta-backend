import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requireWorkspaceRole, workspaceScope } from "../../api/middleware/workspace-scope"
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

const contributor = requireWorkspaceRole("owner", "admin", "member")

knowledgeRoutes.get(
	"/:workspaceId/knowledge-bases",
	workspaceScope,
	knowledgeController.listBases,
)
knowledgeRoutes.post(
	"/:workspaceId/knowledge-bases",
	workspaceScope,
	contributor,
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
	contributor,
	knowledgeController.updateBase,
)
knowledgeRoutes.delete(
	"/:workspaceId/knowledge-bases/:baseId",
	workspaceScope,
	requireWorkspaceRole("owner", "admin"),
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
	contributor,
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
knowledgeRoutes.post(
	"/:workspaceId/documents/:documentId/reindex",
	workspaceScope,
	contributor,
	knowledgeController.reindexDocument,
)
knowledgeRoutes.delete(
	"/:workspaceId/documents/:documentId",
	workspaceScope,
	contributor,
	knowledgeController.deleteDocument,
)
