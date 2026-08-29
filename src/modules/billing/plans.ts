/**
 * Plan catalogue and the commercial rules that go with it. Dependency-free so
 * the auth layer, the billing service, the pricing table and the refill worker
 * all read the same numbers without importing each other.
 *
 * Money model in one line: sell **credits**, not tokens (see ADR-015). One
 * credit is one input token of the baseline model, and every model consumes
 * credits in proportion to what it actually costs us — so gross margin does not
 * move when a customer switches model.
 */

export const PLAN_FREE = "free" as const
export const PLAN_PRO = "pro" as const
export const PLAN_TEAM = "team" as const
export const PLAN_ENTERPRISE = "enterprise" as const

export type PlanName =
	| typeof PLAN_FREE
	| typeof PLAN_PRO
	| typeof PLAN_TEAM
	| typeof PLAN_ENTERPRISE

export const PLAN_NAMES: PlanName[] = [PLAN_FREE, PLAN_PRO, PLAN_TEAM, PLAN_ENTERPRISE]

/**
 * Model access is an entitlement, not a pricing detail. `economy` covers the
 * cheap chat models and every embedding model — the free tier must be able to
 * upload documents, or it cannot demonstrate the product at all.
 */
export type ModelTier = "economy" | "premium"

export interface PlanPrice {
	/** Flat monthly price. Null for per-seat plans and for enterprise. */
	monthlyUsd: number | null
	/** Per-seat monthly price. Null for flat plans. */
	perSeatUsd: number | null
	/** Seats included in `monthlyUsd`. Null when the plan is purely per-seat. */
	includedSeats: number | null
	/** Price of a seat beyond `includedSeats`. */
	extraSeatUsd: number | null
}

export interface PlanLimits {
	/** Members plus pending invitations. null = unlimited. */
	seatLimit: number | null
	/** Credits granted per seat at each refill. Null when the plan is not per-seat. */
	creditsPerSeat: number | null
	/** Credits granted per period regardless of seats. Null when per-seat or unmetered. */
	flatCredits: number | null
	/** May buy top-up packs. Deliberately false on free — see TOPUP_PACKS. */
	topupsEnabled: boolean
	modelTiers: ModelTier[]
	price: PlanPrice
	/** Key into `env.stripe.prices`. Null for plans that are not self-serve. */
	stripePriceKey: "pro" | "team" | null
}

/**
 * Free is a **one-time** grant, not a monthly allowance: both `creditsPerSeat`
 * and `flatCredits` are null, so the refill job skips it entirely and
 * `SIGNUP_GRANT_CREDITS` is all a free workspace ever gets. A monthly free
 * allowance is a standing bill with no conversion pressure.
 */
export const PLAN_LIMITS: Record<PlanName, PlanLimits> = {
	free: {
		seatLimit: 1,
		creditsPerSeat: null,
		flatCredits: null,
		topupsEnabled: false,
		modelTiers: ["economy"],
		price: { monthlyUsd: 0, perSeatUsd: null, includedSeats: 1, extraSeatUsd: null },
		stripePriceKey: null,
	},
	pro: {
		seatLimit: 25,
		creditsPerSeat: 2_000_000,
		flatCredits: null,
		topupsEnabled: true,
		modelTiers: ["economy", "premium"],
		price: { monthlyUsd: null, perSeatUsd: 29, includedSeats: null, extraSeatUsd: 29 },
		stripePriceKey: "pro",
	},
	team: {
		seatLimit: 25,
		creditsPerSeat: null,
		flatCredits: 8_000_000,
		topupsEnabled: true,
		modelTiers: ["economy", "premium"],
		price: { monthlyUsd: 99, perSeatUsd: null, includedSeats: 5, extraSeatUsd: 19 },
		stripePriceKey: "team",
	},
	enterprise: {
		seatLimit: null,
		creditsPerSeat: null,
		flatCredits: null,
		topupsEnabled: true,
		modelTiers: ["economy", "premium"],
		price: { monthlyUsd: null, perSeatUsd: null, includedSeats: null, extraSeatUsd: null },
		// Enterprise is invoiced by hand, never through self-serve checkout.
		stripePriceKey: null,
	},
}

/**
 * One-time credits every new workspace gets. Sized so a free trial is a real
 * trial: on economy models this is roughly 140 retrieval-augmented chat turns
 * plus document ingestion, at well under a dollar of provider cost.
 */
export const SIGNUP_GRANT_CREDITS = 300_000

/**
 * Top-up packs. Never expire and are spent only after the plan bucket is empty.
 *
 * The unit price here is deliberately **higher** than the credits bundled into a
 * plan ($39/M against Pro's ~$14.5/M). If top-ups were cheaper, the rational
 * customer would sit on free and buy packs forever, and the subscription would
 * stop being the product.
 */
export const TOPUP_PACKS = {
	"1m": { credits: 1_000_000, priceUsd: 39, stripePriceKey: "topup1m" },
	"5m": { credits: 5_000_000, priceUsd: 175, stripePriceKey: "topup5m" },
	"15m": { credits: 15_000_000, priceUsd: 450, stripePriceKey: "topup15m" },
} as const

export type TopupPackId = keyof typeof TOPUP_PACKS

export function isPlanName(value: string): value is PlanName {
	return (PLAN_NAMES as string[]).includes(value)
}

export function isTopupPackId(value: string): value is TopupPackId {
	return value in TOPUP_PACKS
}

export function planLimits(plan: PlanName): PlanLimits {
	return PLAN_LIMITS[plan]
}

/** Credits a plan grants at one refill, given how many seats are occupied. */
export function creditsForPeriod(plan: PlanName, seats: number): number | null {
	const limits = planLimits(plan)
	if (limits.flatCredits !== null) return limits.flatCredits
	if (limits.creditsPerSeat !== null) return limits.creditsPerSeat * Math.max(1, seats)
	return null
}

/** Subscription statuses that entitle a workspace to its plan's limits. */
export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"] as const
