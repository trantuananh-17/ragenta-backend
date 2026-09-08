import { Hono } from "hono"

import { rateLimit } from "../../api/middleware/rate-limit"
import type { AppEnv } from "../../api/types"
import { triggerController } from "./trigger.controller"

/**
 * The one router with no session behind it.
 *
 * A webhook is called by a stranger who knows an id and holds a secret, so the
 * secret is the credential and there is no `requireAuth` to add. Everything the
 * endpoint could otherwise leak is collapsed into one answer: a missing trigger,
 * a disabled one and a wrong secret are all 404, because telling them apart
 * turns this into an oracle for which ids exist.
 *
 * Counted by address rather than by user, since there is no user — and counted
 * at all because each accepted call queues a run that spends money.
 */
export const hookRoutes = new Hono<AppEnv>()

hookRoutes.post(
	"/:triggerId",
	rateLimit({
		name: "webhook.fire",
		limit: 60,
		windowSeconds: 60,
		message: "Too many calls to this webhook. Wait a moment and try again.",
	}),
	triggerController.fire,
)
