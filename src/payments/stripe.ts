import Stripe from "stripe"

import { env } from "../config/env"
import { logger } from "../shared/logger"

const log = logger.child({ component: "stripe" })

let client: Stripe | undefined

/**
 * The Stripe client, or undefined when this deployment is not wired for
 * payments.
 *
 * `env.stripe` is only populated when the secret key **and** the webhook secret
 * are both set. A deployment that can charge a card but cannot verify the
 * webhook confirming the charge would take money and never grant the credits —
 * worse than not being able to charge at all.
 */
export function getStripe(): Stripe | undefined {
	if (!env.stripe) return undefined
	if (!client) {
		client = new Stripe(env.stripe.secretKey, {
			// Pinned: a floating API version turns a Stripe-side release into an
			// unannounced change in our webhook payloads.
			apiVersion: "2026-08-26.dahlia",
			appInfo: { name: "ragenta-backend" },
		})
		log.info("stripe.configured")
	}
	return client
}

export function isStripeConfigured(): boolean {
	return env.stripe !== undefined
}

/** The client, or a thrown error. For paths that have already checked. */
export function requireStripe(): Stripe {
	const stripe = getStripe()
	if (!stripe) {
		throw new Error("Stripe is not configured on this deployment.")
	}
	return stripe
}

/** A configured price id by key, or undefined when that product is not on sale here. */
export function stripePriceId(key: keyof NonNullable<typeof env.stripe>["prices"]) {
	return env.stripe?.prices[key]
}
