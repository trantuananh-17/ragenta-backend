import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requireWorkspaceRole, workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { speechController } from "./speech.controller"

/**
 * Both routes spend credits, so neither is open to `viewer` — the same line the
 * attachment upload draws, and for the same reason.
 *
 * Transcription hangs off the attachment it reads rather than living under
 * `/speech`, because it is an operation on that row: it writes the transcript
 * back onto it, and the path says which workspace's row is being scoped.
 */
export const speechRoutes = new Hono<AppEnv>()

speechRoutes.use("*", requireAuth)

const contributor = requireWorkspaceRole("owner", "admin", "member")

speechRoutes.post(
	"/:workspaceId/attachments/:attachmentId/transcribe",
	workspaceScope,
	contributor,
	speechController.transcribe,
)
speechRoutes.post("/:workspaceId/speech", workspaceScope, contributor, speechController.synthesize)
