import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { rateLimit } from "../../api/middleware/rate-limit"
import type { AppEnv } from "../../api/types"
import { requireParam } from "../../api/types"
import { isAppError } from "../../shared/errors"
import { agentRunner } from "../agent/runner"
import { widgetMessageSchema } from "./widget.dto"
import { widgetService } from "./widget.service"

/**
 * The only surface in this product a stranger can reach.
 *
 * No session, no membership, no permission — a visitor on a customer's shop is
 * not a Ragenta member and never will be. What replaces all of that:
 *
 *  - the publishable key names one widget
 *  - the `Origin` allowlist says which page may embed it
 *  - a signed visitor token keeps a conversation together across page loads
 *  - a per-visitor hourly limit and a **per-widget daily credit ceiling** cap the
 *    money, because the origin check stops a misplaced embed and not a script
 *
 * Every refusal answers the same way. Telling a stranger whether a key is
 * unknown, disabled, on the wrong origin or out of budget is telling them which
 * one to work on (ADR-065).
 */
export const widgetRoutes = new Hono<AppEnv>()

/**
 * A permissive CORS for this router only.
 *
 * The app's own CORS (`api/app.ts`) is a fixed allowlist of Ragenta's origins,
 * which is right for every other route and wrong here — a widget is embedded on
 * origins we do not know at build time. The real check is
 * `originAllowed(origin, widget.allowedOrigins)`, done per widget in the handler,
 * because CORS headers are advice to a browser and this is a decision.
 */
widgetRoutes.use("*", async (c, next) => {
	const origin = c.req.header("origin")
	if (origin) {
		c.header("Access-Control-Allow-Origin", origin)
		c.header("Vary", "Origin")
		c.header("Access-Control-Allow-Headers", "content-type, x-ragenta-visitor")
		c.header("Access-Control-Expose-Headers", "x-ragenta-visitor")
		c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	}
	if (c.req.method === "OPTIONS") return c.body(null, 204)
	await next()
})

/**
 * Counted by address here rather than by visitor, deliberately.
 *
 * A visitor token is minted by this very endpoint, so counting by it would let
 * one script mint a fresh identity per request. The per-visitor limit in the
 * service is the fair-use control; this one is the flood control, and it is the
 * only place in the product where an address is the right key because there is
 * nothing else.
 */
const arriving = rateLimit({
	name: "widget.public",
	limit: 60,
	windowSeconds: 60,
	message: "Too many requests. Please try again shortly.",
})

/** What the embed page needs before anybody types: a title, a greeting, a colour. */
widgetRoutes.get("/:publicKey/config", arriving, async (c) => {
	const visitor = await widgetService.resolveVisitor(
		requireParam(c, "publicKey"),
		c.req.header("origin"),
		c.req.header("x-ragenta-visitor"),
	)

	if (visitor.issuedToken) c.header("X-Ragenta-Visitor", visitor.issuedToken)
	return c.json(widgetService.toEmbedConfig(visitor.widget))
})

widgetRoutes.post("/:publicKey/messages", arriving, async (c) => {
	const visitor = await widgetService.resolveVisitor(
		requireParam(c, "publicKey"),
		c.req.header("origin"),
		c.req.header("x-ragenta-visitor"),
	)

	const input = widgetMessageSchema.parse(await c.req.json())

	// Before the model, never after. A refusal that arrives once the tokens are
	// bought is not a limit.
	await widgetService.assertWithinLimits(visitor.widget, visitor.visitorId)

	const prepared = await agentRunner.prepare(
		visitor.widget.organizationId,
		visitor.widget.agentId,
		{ input: input.message },
		// No user. A visitor is not one, and inventing an actor would put a
		// colleague's name on a stranger's conversation.
		null,
		{ trigger: "widget", widgetId: visitor.widget.id },
	)

	if (visitor.issuedToken) c.header("X-Ragenta-Visitor", visitor.issuedToken)
	c.header("X-Accel-Buffering", "no")
	c.header("Cache-Control", "no-cache, no-transform")

	return streamSSE(c, async (stream) => {
		const controller = new AbortController()
		stream.onAbort(() => controller.abort())

		try {
			for await (const event of agentRunner.stream(
				visitor.widget.organizationId,
				prepared,
				controller.signal,
			)) {
				await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
			}
		} catch (error) {
			// A visitor is not a customer of ours and gets no internal detail — but
			// a domain message ("this chat has reached today's limit") is written for
			// them and is the one thing worth saying.
			const message = isAppError(error)
				? error.message
				: "Sorry — something went wrong. Please try again."
			await stream.writeSSE({
				event: "error",
				data: JSON.stringify({ type: "error", message }),
			})
		}
	})
})
