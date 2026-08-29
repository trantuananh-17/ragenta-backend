import { Hono } from "hono"

import type { AppEnv } from "../../api/types"
import { logger } from "../../shared/logger"
import { stripeService } from "./stripe.service"

/**
 * Stripe webhooks. Mounted outside `/v1/workspaces` and with **no auth
 * middleware** — the caller is Stripe, not a session, and the only thing that
 * makes this endpoint trustworthy is the signature check inside
 * `handleWebhook`, which runs before the body is interpreted.
 *
 * The body must be read as raw text. Parsing it to JSON first and re-encoding
 * changes bytes, and the signature is over the bytes.
 */
export const webhookRoutes = new Hono<AppEnv>()

webhookRoutes.post("/stripe", async (c) => {
	const rawBody = await c.req.text()
	const signature = c.req.header("stripe-signature")

	try {
		const result = await stripeService.handleWebhook(rawBody, signature)
		return c.json(result)
	} catch (error) {
		// Answer 400, never 500, on a signature or payload problem: Stripe retries
		// 5xx for days, and a body we cannot verify will never become valid.
		// Genuine processing failures are rethrown so Stripe does retry them.
		if (error instanceof Error && error.name === "StripeSignatureVerificationError") {
			logger.warn("stripe.webhook.bad_signature")
			return c.json({ error: { code: "INVALID_SIGNATURE", message: "Bad signature." } }, 400)
		}
		throw error
	}
})
