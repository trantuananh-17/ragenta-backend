import type Stripe from "stripe"

import { getStripe, stripePriceId } from "../../payments/stripe"
import { ValidationError } from "../../shared/errors"
import { logger } from "../../shared/logger"
import { auditService } from "../audit/audit.service"
import { billingRepository } from "./billing.repository"
import { billingService } from "./billing.service"
import { TOPUP_PACKS, isTopupPackId, planLimits } from "./plans"
import type { TopupPackId } from "./plans"

const log = logger.child({ module: "billing.autoreload" })

/**
 * How long a claimed lock is held. Long enough for the Stripe round trip and
 * the webhook that clears it; short enough that a worker crashing mid-charge
 * does not wedge the workspace forever.
 */
const LOCK_MINUTES = 5

export interface AutoReloadInput {
	enabled: boolean
	thresholdCredits?: number
	pack?: string
}

export const autoReloadService = {
	async get(workspaceId: string) {
		const row = await billingRepository.findPreferences(workspaceId)
		return {
			enabled: row?.autoReloadEnabled ?? false,
			thresholdCredits: row?.autoReloadThresholdCredits ?? null,
			pack: row?.autoReloadPack ?? null,
			lastFailureCode: row?.lastFailureCode ?? null,
			lastFailureAt: row?.lastFailureAt ?? null,
			availablePacks: Object.entries(TOPUP_PACKS).map(([id, pack]) => ({
				id,
				credits: pack.credits,
				priceUsd: pack.priceUsd,
			})),
		}
	},

	async update(workspaceId: string, input: AutoReloadInput, actorId: string) {
		if (input.enabled) {
			const plan = await billingService.getPlan(workspaceId)
			if (!planLimits(plan).topupsEnabled) {
				throw new ValidationError(
					`Auto-reload needs a plan that can buy top-ups. The ${plan} plan cannot.`,
				)
			}
			if (!input.pack || !isTopupPackId(input.pack)) {
				throw new ValidationError("Choose a top-up pack to buy when the balance runs low.")
			}
			if (!input.thresholdCredits || input.thresholdCredits <= 0) {
				throw new ValidationError("Set a credit threshold above zero.")
			}

			// Without a card on file the scan would claim a lock, fail to find a
			// payment method and disable itself on the first tick. Refuse now, with
			// a message that says what to do.
			const subscription = await billingRepository.findSubscription(workspaceId)
			if (!subscription?.externalCustomerId) {
				throw new ValidationError(
					"Add a payment method before enabling auto-reload — buy a top-up or start a subscription first.",
				)
			}
		}

		const saved = await billingRepository.upsertPreferences(workspaceId, {
			autoReloadEnabled: input.enabled,
			autoReloadThresholdCredits: input.thresholdCredits ?? null,
			autoReloadPack: input.pack ?? null,
			// Re-enabling clears the last failure: the customer is telling us the
			// card is fixed, and leaving a stale decline on screen is confusing.
			...(input.enabled ? { lastFailureCode: null, lastFailureAt: null } : {}),
		})

		await auditService.record({
			action: "billing.auto_reload.updated",
			actorId,
			organizationId: workspaceId,
			targetType: "billing_preferences",
			targetId: workspaceId,
			metadata: {
				enabled: input.enabled,
				thresholdCredits: input.thresholdCredits ?? null,
				pack: input.pack ?? null,
			},
		})

		return {
			enabled: saved?.autoReloadEnabled ?? false,
			thresholdCredits: saved?.autoReloadThresholdCredits ?? null,
			pack: saved?.autoReloadPack ?? null,
		}
	},

	/**
	 * One auto-reload pass, driven by the worker.
	 *
	 * Each candidate is claimed with an atomic lock before anything is charged,
	 * so two overlapping ticks — or two worker replicas — cannot both bill the
	 * same card. The lock is released by the webhook on success and here on
	 * failure; if this process dies in between, the lock expires on its own.
	 */
	async runScan() {
		const result = { considered: 0, charged: 0, skipped: 0, failed: 0 }

		const stripe = getStripe()
		if (!stripe) {
			log.info("autoreload.skipped.stripe_not_configured")
			return result
		}

		const candidates = await billingRepository.listAutoReloadCandidates()
		result.considered = candidates.length

		for (const candidate of candidates) {
			const claimed = await billingRepository.claimAutoReloadLock(
				candidate.organizationId,
				LOCK_MINUTES,
			)
			if (!claimed) {
				result.skipped++
				continue
			}

			try {
				const charged = await this.charge(stripe, candidate)
				if (charged) result.charged++
				else result.skipped++
			} catch (error) {
				const code = stripeErrorCode(error)
				log.error("autoreload.charge.failed", error, {
					workspaceId: candidate.organizationId,
					code,
				})
				await billingRepository.releaseAutoReloadLock(candidate.organizationId, code)
				result.failed++
			}
		}

		log.info("autoreload.scan.completed", result)
		return result
	},

	/**
	 * Fire one off-session PaymentIntent. Credits are NOT granted here — the
	 * webhook does that, because a card can be authorised and still fail to
	 * settle, and only Stripe knows which.
	 */
	async charge(
		stripe: Stripe,
		candidate: { organizationId: string; pack: string | null; customerId: string | null },
	) {
		const { organizationId, pack, customerId } = candidate
		if (!customerId || !pack || !isTopupPackId(pack)) {
			await billingRepository.releaseAutoReloadLock(organizationId, "misconfigured")
			return false
		}

		const paymentMethod = await resolveDefaultPaymentMethod(stripe, customerId)
		if (!paymentMethod) {
			await billingRepository.releaseAutoReloadLock(organizationId, "no_payment_method")
			return false
		}

		const amount = await resolvePackAmount(stripe, pack)
		if (!amount) {
			await billingRepository.releaseAutoReloadLock(organizationId, "no_price")
			return false
		}

		const intent = await stripe.paymentIntents.create({
			amount: amount.amount,
			currency: amount.currency,
			customer: customerId,
			payment_method: paymentMethod,
			off_session: true,
			confirm: true,
			metadata: {
				kind: "auto_topup",
				workspaceId: organizationId,
				pack,
				credits: String(TOPUP_PACKS[pack].credits),
			},
		})

		log.info("autoreload.charge.created", {
			workspaceId: organizationId,
			paymentIntentId: intent.id,
			status: intent.status,
			amount: amount.amount,
			currency: amount.currency,
		})
		return true
	},
}

/**
 * Charge what Stripe says the pack costs, not what our constants say. The price
 * of record lives in Stripe, and a customer who sees $39 at checkout must not be
 * charged something else off-session because a constant drifted.
 */
async function resolvePackAmount(stripe: Stripe, packId: TopupPackId) {
	const priceId = stripePriceId(TOPUP_PACKS[packId].stripePriceKey)
	if (!priceId) return null
	const price = await stripe.prices.retrieve(priceId)
	if (typeof price.unit_amount !== "number" || price.unit_amount <= 0) return null
	return { amount: price.unit_amount, currency: price.currency }
}

/**
 * The card to charge off-session: the customer's invoice default, falling back
 * to their most recently attached card.
 */
async function resolveDefaultPaymentMethod(stripe: Stripe, customerId: string) {
	const customer = await stripe.customers.retrieve(customerId)
	if (customer.deleted) return null

	const preferred = customer.invoice_settings?.default_payment_method
	if (typeof preferred === "string") return preferred
	if (preferred && typeof preferred === "object") return preferred.id

	const cards = await stripe.paymentMethods.list({
		customer: customerId,
		type: "card",
		limit: 1,
	})
	return cards.data[0]?.id ?? null
}

/** Stripe puts the useful code in different places depending on the failure. */
function stripeErrorCode(error: unknown): string {
	const candidate = error as { code?: string; decline_code?: string; raw?: { code?: string } }
	return candidate?.decline_code ?? candidate?.code ?? candidate?.raw?.code ?? "stripe_error"
}
