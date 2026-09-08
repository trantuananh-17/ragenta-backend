import { Hono } from "hono"

import { rateLimit } from "../../api/middleware/rate-limit"
import { requireAuth } from "../../api/middleware/session"
import type { AppEnv } from "../../api/types"
import { oauthController } from "./oauth.controller"

/**
 * The callback the provider redirects a browser to.
 *
 * Not workspace-scoped, because the provider's redirect carries only what we put
 * in the `state` — and the workspace is inside that, signed for by the fact that
 * only we could have written it into Redis. It **is** session-scoped: the person
 * completing the authorization has to be the one who started it, which is the
 * check that makes a stolen state parameter useless (`pkce.ts`).
 *
 * Counted, because each accepted callback exchanges a code with a third party.
 */
export const oauthCallbackRoutes = new Hono<AppEnv>()

oauthCallbackRoutes.use("*", requireAuth)

oauthCallbackRoutes.get(
	"/:provider/callback",
	rateLimit({
		name: "oauth.callback",
		limit: 20,
		windowSeconds: 300,
		message: "Too many authorization attempts. Wait a moment and try again.",
	}),
	oauthController.callback,
)
