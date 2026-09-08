import { Hono } from "hono"

import { rateLimit } from "../../api/middleware/rate-limit"
import { requireAuth } from "../../api/middleware/session"
import { requirePermission } from "../../api/middleware/require-permission"
import { workspaceScope } from "../../api/middleware/workspace-scope"
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


/** Both routes are a paid provider call each. Counted together, per person. */
const speaking = rateLimit({
	name: "speech",
	limit: 30,
	windowSeconds: 60,
	message: "Too many recordings in a row. Wait a moment and try again.",
})

speechRoutes.post(
	"/:workspaceId/attachments/:attachmentId/transcribe",
	workspaceScope,
	requirePermission("speech.transcribe"),
	speaking,
	speechController.transcribe,
)
speechRoutes.post(
	"/:workspaceId/speech",
	workspaceScope,
	requirePermission("speech.synthesize"),
	speaking,
	speechController.synthesize,
)
