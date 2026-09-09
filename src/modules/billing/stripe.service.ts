import type Stripe from "stripe"

import { env } from "../../config/env"
import { requireStripe, stripePriceId } from "../../payments/stripe"
import { NotFoundError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import { auditService } from "../audit/audit.service"
import { workspaceRepository } from "../workspace/workspace.repository"
import { billingRepository } from "./billing.repository"
import { billingService } from "./billing.service"
import { paymentRepository } from "./payment.repository"
import { PLAN_FREE, TOPUP_PACKS, planLimits } from "./plans"
import type { PlanName, TopupPackId } from "./plans"

const log = logger.child({ module: "billing.stripe" })

/** Stripe timestamps are unix seconds, and null means "not set", not "epoch". */
function toDate(seconds: number | null | undefined): Date | null {
	return typeof seconds === "number" ? new Date(seconds * 1000) : null
}

/**
 * Period bounds moved from the subscription onto its items in recent API
 * versions. Read the item first and fall back, so this keeps working across the
 * version bump rather than silently writing nulls.
 */
function periodBounds(subscription: Stripe.Subscription) {
	const item = subscription.items.data[0] as unknown as {
		current_period_start?: number
		current_period_end?: number
	}
	const legacy = subscription as unknown as {
		current_period_start?: number
		current_period_end?: number
	}
	return {
		start: toDate(item?.current_period_start ?? legacy.current_period_start),
		end: toDate(item?.current_period_end ?? legacy.current_period_end),
	}
}

/** Which plan a Stripe price belongs to. Unknown prices are not guessed at. */
function planForPrice(priceId: string | undefined): PlanName | undefined {
	if (!priceId) return undefined
	const prices = env.stripe?.prices
	if (!prices) return undefined
	if (priceId === prices.pro) return "pro"
	if (priceId === prices.team) return "team"
	return undefined
}

export const stripeService = {
	/**
	 * The workspace's Stripe customer, created on first need.
	 *
	 * Stored on the subscription row, which every workspace has from
	 * provisioning, so there is exactly one customer per workspace and no
	 * separate table to keep in step.
	 */
	async ensureCustomer(workspaceId: string, billingEmail: string) {
		const subscription = await billingRepository.findSubscription(workspaceId)
		if (!subscription) throw new NotFoundError("Subscription")
		if (subscription.externalCustomerId) return subscription.externalCustomerId

		const workspace = await workspaceRepository.findById(workspaceId)
		const customer = await requireStripe().customers.create({
			email: billingEmail,
			name: workspace?.name,
			metadata: { workspaceId },
		})

		await billingRepository.updateSubscription(workspaceId, {
			externalCustomerId: customer.id,
		})
		log.info("stripe.customer.created", { workspaceId, customerId: customer.id })
		return customer.id
	},

	/**
	 * Checkout for a plan upgrade. Seats are billed by quantity, so the session
	 * is created with the seat count the workspace has right now.
	 */
	async createPlanCheckout(
		workspaceId: string,
		plan: PlanName,
		actorId: string,
		billingEmail: string,
	) {
		const priceKey = planLimits(plan).stripePriceKey
		if (!priceKey) {
			throw new ValidationError(`The ${plan} plan is not available for self-serve checkout.`)
		}
		const price = stripePriceId(priceKey)
		if (!price) {
			throw new ValidationError(`No Stripe price configured for the ${plan} plan.`)
		}

		const customer = await this.ensureCustomer(workspaceId, billingEmail)
		const seats = Math.max(1, await workspaceRepository.countMembers(workspaceId))

		const session = await requireStripe().checkout.sessions.create({
			mode: "subscription",
			customer,
			line_items: [{ price, quantity: seats }],
			success_url: `${env.appBaseUrl}/settings/billing?checkout=success`,
			cancel_url: `${env.appBaseUrl}/settings/billing?checkout=cancelled`,
			// Read back on the webhook — the session is the only place that knows
			// which workspace started this.
			metadata: { kind: "subscription", workspaceId, plan },
			subscription_data: { metadata: { workspaceId, plan } },
		})

		await auditService.record({
			action: "billing.checkout.started",
			actorId,
			organizationId: workspaceId,
			targetType: "checkout_session",
			targetId: session.id,
			metadata: { kind: "subscription", plan, seats },
		})

		return { url: session.url, sessionId: session.id }
	},

	async createTopupCheckout(
		workspaceId: string,
		packId: TopupPackId,
		actorId: string,
		billingEmail: string,
	) {
		const plan = await billingService.getPlan(workspaceId)
		if (!planLimits(plan).topupsEnabled) {
			throw new ValidationError(
				`Top-ups are not available on the ${plan} plan. Upgrade first.`,
			)
		}

		const pack = TOPUP_PACKS[packId]
		const price = stripePriceId(pack.stripePriceKey)
		if (!price) {
			throw new ValidationError(`No Stripe price configured for the ${packId} top-up pack.`)
		}

		const customer = await this.ensureCustomer(workspaceId, billingEmail)

		const session = await requireStripe().checkout.sessions.create({
			mode: "payment",
			customer,
			line_items: [{ price, quantity: 1 }],
			success_url: `${env.appBaseUrl}/settings/billing?topup=success`,
			cancel_url: `${env.appBaseUrl}/settings/billing?topup=cancelled`,
			metadata: {
				kind: "topup",
				workspaceId,
				pack: packId,
				credits: String(pack.credits),
			},
			// Keep the card on file so auto-reload has something to charge later.
			payment_intent_data: { setup_future_usage: "off_session" },
		})

		await auditService.record({
			action: "billing.checkout.started",
			actorId,
			organizationId: workspaceId,
			targetType: "checkout_session",
			targetId: session.id,
			metadata: { kind: "topup", pack: packId, credits: pack.credits },
		})

		return { url: session.url, sessionId: session.id }
	},

	/** Stripe's hosted portal — card changes, invoices and cancellation live there. */
	async createPortalSession(workspaceId: string, billingEmail: string) {
		const customer = await this.ensureCustomer(workspaceId, billingEmail)
		const session = await requireStripe().billingPortal.sessions.create({
			customer,
			return_url: `${env.appBaseUrl}/settings/billing`,
		})
		return { url: session.url }
	},

	/**
	 * Verify and apply a webhook.
	 *
	 * Signature verification happens before anything is read: the body is
	 * attacker-controlled until Stripe's signature says otherwise, and every
	 * handler below moves credits.
	 */
	async handleWebhook(rawBody: string, signature: string | undefined) {
		if (!signature) throw new ValidationError("Missing Stripe signature.")
		if (!env.stripe) throw new ValidationError("Stripe is not configured.")

		const event = requireStripe().webhooks.constructEvent(
			rawBody,
			signature,
			env.stripe.webhookSecret,
		)

		log.info("stripe.webhook", { type: event.type, eventId: event.id })

		switch (event.type) {
			case "checkout.session.completed":
				await this.onCheckoutCompleted(event.data.object)
				break
			case "customer.subscription.created":
			case "customer.subscription.updated":
			case "customer.subscription.deleted":
				await this.onSubscriptionChanged(event.data.object)
				break
			case "invoice.paid":
			case "invoice.payment_failed":
				await this.onInvoice(event.data.object, event.type === "invoice.paid" ? "paid" : "failed")
				break
			case "payment_intent.succeeded":
				await this.onAutoReloadSucceeded(event.data.object)
				break
			case "payment_intent.payment_failed":
				await this.onAutoReloadFailed(event.data.object)
				break
			default:
				// Stripe sends far more than we subscribe to; ignoring the rest is
				// correct, and returning 200 stops it retrying them forever.
				break
		}

		return { received: true, type: event.type }
	},

	async onCheckoutCompleted(session: Stripe.Checkout.Session) {
		const workspaceId = session.metadata?.workspaceId
		if (!workspaceId) {
			log.warn("stripe.checkout.no_workspace", { sessionId: session.id })
			return
		}

		if (session.mode === "subscription") {
			// Promote the subscription's card to the customer's invoice default so
			// auto-reload has an off-session payment method later. Best effort: a
			// failure here must not fail the webhook and make Stripe retry a
			// checkout that already succeeded.
			try {
				await this.saveDefaultPaymentMethod(session)
			} catch (error) {
				log.warn("stripe.default_pm.failed", {
					sessionId: session.id,
					reason: error instanceof Error ? error.message : String(error),
				})
			}
			return
		}

		if (session.mode !== "payment" || session.metadata?.kind !== "topup") return

		const credits = Number(session.metadata.credits)
		if (!Number.isFinite(credits) || credits <= 0) {
			log.error("stripe.topup.bad_metadata", undefined, {
				sessionId: session.id,
				metadata: session.metadata,
			})
			return
		}

		// The session id, not the event id: Stripe redelivers the same event with
		// a new envelope, and the ledger's unique (kind, reference) is what makes
		// the redelivery a no-op.
		const result = await billingService.grant({
			workspaceId,
			amount: credits,
			bucket: "topup",
			kind: "topup",
			reference: `stripe:${session.id}`,
			reason: `Top-up pack ${session.metadata.pack ?? "unknown"}`,
		})

		// The money beside the credits. The grant above is what they may spend; this
		// is what they paid for it, and until now that number lived only in Stripe.
		await paymentRepository.record({
			id: newId(),
			organizationId: workspaceId,
			kind: "topup",
			status: "paid",
			amountUsd: ((session.amount_total ?? 0) / 100).toFixed(2),
			currency: session.currency ?? "usd",
			description: `Top-up pack ${session.metadata.pack ?? "unknown"}`,
			externalId: session.id,
		})

		log.info("stripe.topup.applied", {
			workspaceId,
			credits,
			alreadyApplied: result.alreadyApplied,
		})
	},

	/**
	 * Record a subscription charge, succeeded or not.
	 *
	 * A failure is written rather than ignored: it is the reason a workspace is
	 * about to lose its plan, and a billing screen that shows only successes makes
	 * that look like it happened for no reason.
	 *
	 * The invoice id is the idempotency key, so Stripe redelivering the same event
	 * updates one row instead of adding another — and the failure that precedes a
	 * successful retry becomes that same row turning `paid`.
	 */
	async onInvoice(invoice: Stripe.Invoice, status: "paid" | "failed") {
		const workspaceId = await workspaceForInvoice(invoice)
		if (!workspaceId) {
			log.warn("stripe.invoice.no_workspace", { invoiceId: invoice.id })
			return
		}

		const line = invoice.lines?.data?.[0]
		// `amount_paid` is zero on a failure, and the customer needs to see what was
		// attempted rather than a row saying nothing was owed.
		const cents = status === "paid" ? invoice.amount_paid : invoice.amount_due

		await paymentRepository.record({
			id: newId(),
			organizationId: workspaceId,
			kind: "subscription",
			status,
			amountUsd: (cents / 100).toFixed(2),
			currency: invoice.currency ?? "usd",
			description: line?.description ?? "Subscription",
			externalId: invoice.id ?? `invoice:${workspaceId}:${invoice.created}`,
			hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
			invoicePdfUrl: invoice.invoice_pdf ?? null,
			periodStart: line?.period?.start ? new Date(line.period.start * 1000) : null,
			periodEnd: line?.period?.end ? new Date(line.period.end * 1000) : null,
		})

		log.info("stripe.invoice.recorded", { workspaceId, status, invoiceId: invoice.id })
	},

	async saveDefaultPaymentMethod(session: Stripe.Checkout.Session) {
		if (!session.customer || !session.subscription) return
		const stripe = requireStripe()

		const subscriptionId =
			typeof session.subscription === "string" ? session.subscription : session.subscription.id
		const subscription = await stripe.subscriptions.retrieve(subscriptionId)
		const paymentMethod =
			typeof subscription.default_payment_method === "string"
				? subscription.default_payment_method
				: subscription.default_payment_method?.id
		if (!paymentMethod) return

		const customerId =
			typeof session.customer === "string" ? session.customer : session.customer.id
		await stripe.customers.update(customerId, {
			invoice_settings: { default_payment_method: paymentMethod },
		})
	},

	/**
	 * Mirror a Stripe subscription onto our row, and grant this period's credits
	 * when it is active.
	 *
	 * The grant goes through the normal refill, which is idempotent per month, so
	 * an upgrade mid-month grants once and the scheduled refill later that month
	 * does nothing.
	 */
	async onSubscriptionChanged(subscription: Stripe.Subscription) {
		const workspaceId =
			subscription.metadata?.workspaceId ??
			(await billingRepository.findByExternalSubscriptionId(subscription.id))
				?.organizationId

		if (!workspaceId) {
			log.warn("stripe.subscription.no_workspace", { subscriptionId: subscription.id })
			return
		}

		const item = subscription.items.data[0]
		const plan = planForPrice(item?.price.id)
		const period = periodBounds(subscription)
		const isActive = subscription.status === "active" || subscription.status === "trialing"

		await billingRepository.updateSubscription(workspaceId, {
			// A cancelled subscription keeps its plan name on the row; `getPlan`
			// reads the status, so entitlement drops to free without losing the
			// record of what they were on.
			...(plan ? { plan } : {}),
			status: subscription.status,
			seats: item?.quantity ?? 1,
			billingInterval: item?.price.recurring?.interval === "year" ? "yearly" : "monthly",
			periodStart: period.start,
			periodEnd: period.end,
			cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
			canceledAt: toDate(subscription.canceled_at),
			externalSubscriptionId: subscription.id,
			externalCustomerId:
				typeof subscription.customer === "string"
					? subscription.customer
					: subscription.customer.id,
		})

		if (isActive && plan) {
			await billingService.refillPlanCredits(workspaceId)
		}

		await auditService.record({
			action: "billing.subscription.synced",
			organizationId: workspaceId,
			targetType: "subscription",
			targetId: subscription.id,
			metadata: {
				plan: plan ?? PLAN_FREE,
				status: subscription.status,
				seats: item?.quantity ?? 1,
			},
		})

		log.info("stripe.subscription.synced", {
			workspaceId,
			plan,
			status: subscription.status,
		})
	},

	async onAutoReloadSucceeded(intent: Stripe.PaymentIntent) {
		if (intent.metadata?.kind !== "auto_topup") return
		const workspaceId = intent.metadata.workspaceId
		const credits = Number(intent.metadata.credits)
		if (!workspaceId || !Number.isFinite(credits) || credits <= 0) {
			log.error("stripe.auto_topup.bad_metadata", undefined, {
				paymentIntentId: intent.id,
				metadata: intent.metadata,
			})
			return
		}

		// The PaymentIntent id, not the event id, so every redelivery of this
		// event collapses onto one ledger row.
		await billingService.grant({
			workspaceId,
			amount: credits,
			bucket: "topup",
			kind: "topup",
			reference: `stripe:${intent.id}`,
			reason: "Auto-reload",
		})

		await paymentRepository.record({
			id: newId(),
			organizationId: workspaceId,
			kind: "topup",
			status: "paid",
			amountUsd: (intent.amount / 100).toFixed(2),
			currency: intent.currency ?? "usd",
			description: `Auto-reload ${intent.metadata.pack ?? ""}`.trim(),
			externalId: intent.id,
		})

		await billingRepository.releaseAutoReloadLock(workspaceId)
		log.info("stripe.auto_topup.applied", { workspaceId, credits })
	},

	async onAutoReloadFailed(intent: Stripe.PaymentIntent) {
		if (intent.metadata?.kind !== "auto_topup") return
		const workspaceId = intent.metadata.workspaceId
		if (!workspaceId) return

		const code =
			intent.last_payment_error?.decline_code ??
			intent.last_payment_error?.code ??
			"payment_failed"

		await billingRepository.releaseAutoReloadLock(workspaceId, code)
		log.warn("stripe.auto_topup.failed", { workspaceId, code })
	},
}

/**
 * Which workspace an invoice belongs to.
 *
 * Resolved through the customer rather than the subscription. One workspace has
 * at most one subscription row — `subscription_organizationId_uidx` enforces it —
 * and the customer id is on it from the moment `ensureCustomer` ran, so this
 * answers for a one-off invoice as well as a recurring one. It also avoids
 * reading a field the Stripe SDK has moved between API versions.
 *
 * A miss is logged rather than guessed at: attributing money to the wrong
 * workspace is worse than not recording it.
 */
async function workspaceForInvoice(invoice: Stripe.Invoice): Promise<string | undefined> {
	const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id
	if (!customerId) return undefined

	return (await billingRepository.findByExternalCustomerId(customerId))?.organizationId
}
