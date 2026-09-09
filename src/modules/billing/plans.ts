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
export const PLAN_STARTER = "starter" as const
export const PLAN_PRO = "pro" as const
export const PLAN_TEAM = "team" as const
export const PLAN_ENTERPRISE = "enterprise" as const

export type PlanName =
	| typeof PLAN_FREE
	| typeof PLAN_STARTER
	| typeof PLAN_PRO
	| typeof PLAN_TEAM
	| typeof PLAN_ENTERPRISE

/**
 * Ordered cheapest first. An upgrade prompt walks this list to name the first
 * plan that lifts whatever the customer just hit, so the order is load-bearing:
 * reordering it would quote enterprise at somebody who needed starter.
 */
export const PLAN_NAMES: PlanName[] = [
	PLAN_FREE,
	PLAN_STARTER,
	PLAN_PRO,
	PLAN_TEAM,
	PLAN_ENTERPRISE,
]

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
	/**
	 * Embeddable chat widgets this plan may publish. 0 on free, null unlimited.
	 *
	 * Free carries none deliberately: a widget is a **public, unauthenticated**
	 * endpoint that calls a model, which is the clearest abuse surface in the
	 * product — and it is the feature worth upgrading for (ADR-065).
	 */
	widgetLimit: number | null
	/**
	 * Knowledge bases this plan may hold. null = unlimited.
	 *
	 * A base is the unit a workspace organises retrieval around, and the cheap
	 * plans are sold for one use case each — one on free is enough to try the
	 * product on a real corpus, and needing a second one is the first honest
	 * signal that this is no longer a trial.
	 */
	knowledgeBaseLimit: number | null
	/**
	 * Agents this plan may hold. null = unlimited.
	 *
	 * Two on free so an assistant and a comparison are both possible; the cap
	 * rises with the plan because building a fleet of agents is the team-sized
	 * use of the product, not the evaluation of it.
	 */
	agentLimit: number | null
	/**
	 * May mint workspace API keys.
	 *
	 * Programmatic access is what turns Ragenta into somebody else's backend, and
	 * it is also an unattended spend surface — a loop with a key on it can empty a
	 * balance overnight. Both reasons point at the same boundary: a plan with a
	 * card behind it and a per-seat price that scales with the usage.
	 */
	apiKeysEnabled: boolean
	/**
	 * May connect an external database as a data source.
	 *
	 * A stored DSN is a credential to a customer's own production database, held
	 * encrypted and queried on their behalf. That is the heaviest trust the
	 * product asks for, and it is not extended to accounts that have never paid.
	 */
	dataSourcesEnabled: boolean
	/**
	 * May create outbound webhook endpoints and agent triggers.
	 *
	 * Both make the platform act without a person present — we call out to an
	 * arbitrary URL, or a schedule spends credits at 3am. Gating them behind the
	 * cheapest paid plan keeps unattended egress attached to an identified,
	 * billable account rather than to a signup form.
	 */
	automationEnabled: boolean
	price: PlanPrice
	/** Key into `env.stripe.prices`. Null for plans that are not self-serve. */
	stripePriceKey: "starter" | "pro" | "team" | null
}

/**
 * The counted resources a plan caps, with the noun a refusal uses. Keyed by the
 * `PlanLimits` field so the guard, the message and the number cannot drift.
 */
export const COUNTED_PLAN_LIMITS = {
	knowledgeBaseLimit: { one: "knowledge base", many: "knowledge bases" },
	agentLimit: { one: "agent", many: "agents" },
} as const

export type CountedPlanLimit = keyof typeof COUNTED_PLAN_LIMITS

/** The all-or-nothing capabilities a plan unlocks, with the noun a refusal uses. */
export const GATED_PLAN_FEATURES = {
	apiKeysEnabled: "API keys",
	dataSourcesEnabled: "Data sources",
	automationEnabled: "Webhooks and triggers",
} as const

export type GatedPlanFeature = keyof typeof GATED_PLAN_FEATURES

/**
 * Free carries no allowance at all — `creditsPerSeat` and `flatCredits` are both
 * null, and nothing grants it credits on a schedule. It is funded once, by
 * `SIGNUP_GRANT_CREDITS`, and never again.
 *
 * Starter is the step off that cliff: flat rather than per-seat, because it is
 * sold to one person, and a per-seat price on a single-seat plan is a number
 * that can only ever be multiplied by one.
 */
export const PLAN_LIMITS: Record<PlanName, PlanLimits> = {
	free: {
		seatLimit: 1,
		creditsPerSeat: null,
		flatCredits: null,
		topupsEnabled: false,
		modelTiers: ["economy"],
		widgetLimit: 0,
		knowledgeBaseLimit: 1,
		agentLimit: 2,
		apiKeysEnabled: false,
		dataSourcesEnabled: false,
		automationEnabled: false,
		price: { monthlyUsd: 0, perSeatUsd: null, includedSeats: 1, extraSeatUsd: null },
		stripePriceKey: null,
	},
	starter: {
		seatLimit: 1,
		creditsPerSeat: null,
		flatCredits: 500_000,
		topupsEnabled: true,
		modelTiers: ["economy"],
		widgetLimit: 1,
		knowledgeBaseLimit: 3,
		agentLimit: 5,
		apiKeysEnabled: false,
		dataSourcesEnabled: false,
		automationEnabled: true,
		price: { monthlyUsd: 9, perSeatUsd: null, includedSeats: 1, extraSeatUsd: null },
		stripePriceKey: "starter",
	},
	pro: {
		seatLimit: 25,
		creditsPerSeat: 2_000_000,
		flatCredits: null,
		topupsEnabled: true,
		modelTiers: ["economy", "premium"],
		widgetLimit: 1,
		knowledgeBaseLimit: 10,
		agentLimit: 20,
		apiKeysEnabled: true,
		dataSourcesEnabled: true,
		automationEnabled: true,
		price: { monthlyUsd: null, perSeatUsd: 29, includedSeats: null, extraSeatUsd: 29 },
		stripePriceKey: "pro",
	},
	team: {
		seatLimit: 25,
		creditsPerSeat: null,
		flatCredits: 8_000_000,
		topupsEnabled: true,
		modelTiers: ["economy", "premium"],
		widgetLimit: 5,
		knowledgeBaseLimit: null,
		agentLimit: null,
		apiKeysEnabled: true,
		dataSourcesEnabled: true,
		automationEnabled: true,
		price: { monthlyUsd: 99, perSeatUsd: null, includedSeats: 5, extraSeatUsd: 19 },
		stripePriceKey: "team",
	},
	enterprise: {
		seatLimit: null,
		creditsPerSeat: null,
		flatCredits: null,
		topupsEnabled: true,
		modelTiers: ["economy", "premium"],
		widgetLimit: null,
		knowledgeBaseLimit: null,
		agentLimit: null,
		apiKeysEnabled: true,
		dataSourcesEnabled: true,
		automationEnabled: true,
		price: { monthlyUsd: null, perSeatUsd: null, includedSeats: null, extraSeatUsd: null },
		// Enterprise is invoiced by hand, never through self-serve checkout.
		stripePriceKey: null,
	},
}

/**
 * The whole of the free tier: 20k credits an **account** gets once, on the first
 * workspace it creates. Nothing is granted after it — free is a trial, not a
 * standing allowance.
 *
 * A monthly allowance that never ends is a cost with no end and no upgrade
 * pressure: an account can sit on it forever and never have a reason to pay. The
 * free plan's real conversion levers are the single seat, the zero widgets and
 * the economy-only model tier — credits were never the thing being bought.
 *
 * Lands in the top-up bucket, so it rolls over rather than being wiped by the
 * first refill of a plan the workspace is later put on.
 */
export const SIGNUP_GRANT_CREDITS = 20_000

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

/**
 * A top-up of any whole-dollar amount, priced at the smallest pack's unit price.
 *
 * Deliberately the 1M pack's rate rather than a new one: the 5M ($35/M) and 15M
 * ($30/M) packs stay the cheaper way to buy in volume, so naming an amount can
 * never undercut a pack.
 *
 * The floor is Stripe's fee — $0.30 + 2.9% is 5.8% of a $10 payment and grows
 * fast below it.
 *
 * The ceiling is a typo and stolen-card guard, set at roughly four times the
 * largest pack: no self-serve customer needs more than that in one press, and
 * anyone who does is a sales conversation and an invoice, which is how
 * enterprise is sold anyway. It also caps a single fraudulent charge, and with
 * it the chargeback and the Stripe dispute fee.
 */
export const CUSTOM_TOPUP_MIN_USD = 10
export const CUSTOM_TOPUP_MAX_USD = 2_000
export const CUSTOM_TOPUP_USD_PER_MILLION_CREDITS = TOPUP_PACKS["1m"].priceUsd

/**
 * Credits a custom top-up amount buys.
 *
 * Rounded **down**: a credit is a unit granted to the ledger, and rounding up
 * would grant a fraction of one nobody paid for. The remainder is worth
 * ~0.004 cents, so the customer loses nothing they would notice, and the
 * balance stays an integer count of what was bought.
 */
export function creditsForCustomTopupUsd(amountUsd: number): number {
	return Math.floor((amountUsd * 1_000_000) / CUSTOM_TOPUP_USD_PER_MILLION_CREDITS)
}

export function isPlanName(value: string): value is PlanName {
	return (PLAN_NAMES as string[]).includes(value)
}

export function isTopupPackId(value: string): value is TopupPackId {
	return value in TOPUP_PACKS
}

export function planLimits(plan: PlanName): PlanLimits {
	return PLAN_LIMITS[plan]
}

/**
 * The cheapest plan that allows more of a counted resource than `plan` does, or
 * null when nothing does.
 *
 * A refusal that only says "you have reached your limit" leaves the customer to
 * go and read a pricing page to find out what to do about it. Naming the plan
 * turns the refusal into the upgrade prompt.
 */
export function planRaisingLimit(plan: PlanName, limit: CountedPlanLimit): PlanName | null {
	const current = planLimits(plan)[limit]
	if (current === null) return null
	return (
		PLAN_NAMES.find((candidate) => {
			const allowed = planLimits(candidate)[limit]
			return allowed === null || allowed > current
		}) ?? null
	)
}

/** The cheapest plan that unlocks a capability, or null when every plan has it. */
export function planUnlockingFeature(feature: GatedPlanFeature): PlanName | null {
	return PLAN_NAMES.find((candidate) => planLimits(candidate)[feature]) ?? null
}

/** Credits a plan grants at one refill, given how many seats are occupied. */
export function creditsForPeriod(plan: PlanName, seats: number): number | null {
	const limits = planLimits(plan)
	if (limits.flatCredits !== null) return limits.flatCredits
	if (limits.creditsPerSeat !== null) return limits.creditsPerSeat * Math.max(1, seats)
	return null
}

/**
 * What one workspace on this plan bills in a month, given its occupied seats.
 *
 * `null` means the plan carries no list price — enterprise is invoiced by hand,
 * and inventing a number for it would put a figure nobody agreed to into a
 * revenue total. The caller reports those workspaces separately rather than as
 * zero, because "we do not know" and "it is free" are different answers.
 *
 * Here rather than in the revenue service because it is the same kind of rule as
 * `creditsForPeriod` — a commercial constant the pricing table already carries —
 * and this file is the one place both the seat cap and the invoice read it from.
 */
export function monthlyPriceUsd(plan: PlanName, seats: number): number | null {
	const { price } = planLimits(plan)

	if (price.monthlyUsd !== null) {
		const included = price.includedSeats ?? 0
		const extra = Math.max(0, seats - included) * (price.extraSeatUsd ?? 0)
		return price.monthlyUsd + extra
	}

	if (price.perSeatUsd !== null) return price.perSeatUsd * Math.max(1, seats)

	return null
}

/** The list price of a top-up pack, found by the credits it grants. */
export function topupPackByCredits(credits: number) {
	return Object.entries(TOPUP_PACKS).find(([, pack]) => pack.credits === credits)?.[1]
}

/** Subscription statuses that entitle a workspace to its plan's limits. */
export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"] as const
