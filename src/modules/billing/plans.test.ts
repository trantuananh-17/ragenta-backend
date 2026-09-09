import { describe, expect, it } from "vitest"

import { createCheckoutSchema } from "./billing.dto"
import {
	COUNTED_PLAN_LIMITS,
	CUSTOM_TOPUP_MAX_USD,
	CUSTOM_TOPUP_MIN_USD,
	PLAN_LIMITS,
	PLAN_NAMES,
	SIGNUP_GRANT_CREDITS,
	TOPUP_PACKS,
	creditsForCustomTopupUsd,
	creditsForPeriod,
	isPlanName,
	isTopupPackId,
	monthlyPriceUsd,
	planLimits,
	planRaisingLimit,
	planUnlockingFeature,
	topupPackByCredits,
} from "./plans"
import type { CountedPlanLimit, PlanLimits } from "./plans"

/**
 * The plan catalogue is the product's price list, and every number in it is
 * read by something that cannot argue back: the refill job grants what
 * `creditsForPeriod` returns, the seat guard refuses at `seatLimit`, and the
 * model picker offers what `modelTiers` allows. A wrong number here is not a
 * crash — it is a month of the wrong allowance granted to every workspace on
 * that plan, already committed to the ledger and not restatable.
 *
 * The commercial invariants are tested alongside the arithmetic because they
 * are the part a well-meaning change breaks: making top-ups cheaper "so people
 * buy more" inverts the reason the subscription exists, and it would pass a
 * review that only looked at whether the code compiled.
 */

describe("creditsForPeriod", () => {
	it("grants a per-seat plan its allowance for every occupied seat", () => {
		expect(creditsForPeriod("pro", 1)).toBe(2_000_000)
		expect(creditsForPeriod("pro", 4)).toBe(8_000_000)
	})

	it("never grants a per-seat plan less than one seat's worth", () => {
		// A workspace whose members are still being counted, or one momentarily
		// empty, would otherwise refill to nothing and read as out of credit.
		expect(creditsForPeriod("pro", 0)).toBe(2_000_000)
	})

	it("grants a flat plan the same amount however many seats it uses", () => {
		// Team is sold as a bundle: seats change what it costs, not what it gets.
		expect(creditsForPeriod("team", 1)).toBe(8_000_000)
		expect(creditsForPeriod("team", 25)).toBe(8_000_000)
		// Starter is single-seat and flat, so the seat count can only ever be one.
		expect(creditsForPeriod("starter", 1)).toBe(500_000)
	})

	it("schedules nothing for the plans that are not granted on a schedule", () => {
		// Free is a one-time trial and enterprise is invoiced and topped up by
		// hand. Both must answer null, or the refill job would grant them
		// something every month.
		expect(creditsForPeriod("free", 1)).toBeNull()
		expect(creditsForPeriod("enterprise", 50)).toBeNull()
	})
})

describe("planLimits", () => {
	it("caps the free plan at a single seat", () => {
		expect(planLimits("free").seatLimit).toBe(1)
	})

	it("leaves enterprise uncapped", () => {
		// Null means unlimited, and the seat guard returns early on it. A zero
		// here would refuse every invitation on the most expensive plan.
		expect(planLimits("enterprise").seatLimit).toBeNull()
	})

	it("gives the free plan the cheap models and nothing else", () => {
		// Economy covers every embedding model too, or a free workspace could not
		// index a document and the product could not be demonstrated at all.
		expect(planLimits("free").modelTiers).toEqual(["economy"])
	})

	it("keeps starter on the cheap models", () => {
		// $9 flat does not carry a premium-model workspace: the frontier models are
		// what the per-seat plans are priced to absorb.
		expect(planLimits("starter").modelTiers).toEqual(["economy"])
	})

	it("gives every per-seat and negotiated plan both tiers", () => {
		for (const plan of ["pro", "team", "enterprise"] as const) {
			expect(planLimits(plan).modelTiers).toContain("premium")
			expect(planLimits(plan).modelTiers).toContain("economy")
		}
	})

	it("refuses top-ups on free and allows them everywhere else", () => {
		// Free has no card on file and no subscription behind it; letting it buy
		// packs would make it a standalone pay-as-you-go tier by accident.
		expect(planLimits("free").topupsEnabled).toBe(false)
		for (const plan of ["starter", "pro", "team", "enterprise"] as const) {
			expect(planLimits(plan).topupsEnabled).toBe(true)
		}
	})

	it("sells starter through self-serve checkout", () => {
		// Without a price key the upgrade button on the paywall has nothing to open.
		expect(planLimits("starter").stripePriceKey).toBe("starter")
	})

	it("keeps enterprise out of self-serve checkout", () => {
		// A Stripe price key is what makes a plan buyable from the billing screen.
		expect(planLimits("enterprise").stripePriceKey).toBeNull()
		expect(planLimits("free").stripePriceKey).toBeNull()
	})

	it("describes every plan the product names", () => {
		for (const plan of PLAN_NAMES) {
			expect(PLAN_LIMITS[plan]).toBeDefined()
		}
		expect(Object.keys(PLAN_LIMITS).sort()).toEqual([...PLAN_NAMES].sort())
	})

	it("gives every plan a value for every limit", () => {
		// A plan added later with a field left off would read as `undefined`, and
		// an undefined limit gates nothing — so the new plan would silently be
		// unlimited on every feature at once rather than failing anywhere visible.
		const fields = Object.keys(PLAN_LIMITS.free) as (keyof PlanLimits)[]

		for (const plan of PLAN_NAMES) {
			for (const field of fields) {
				expect(PLAN_LIMITS[plan][field]).toBeDefined()
			}
		}
	})
})

/**
 * What each plan unlocks, as opposed to what it funds. These are the boundaries
 * the domain services refuse at, so a value moved here silently opens or closes
 * a feature for every workspace on that plan.
 */
describe("the feature ladder", () => {
	it("lets the free plan hold enough to evaluate the product and no more", () => {
		expect(planLimits("free").knowledgeBaseLimit).toBe(1)
		expect(planLimits("free").agentLimit).toBe(2)
		expect(planLimits("free").widgetLimit).toBe(0)
	})

	it("never allows less of something on a more expensive plan", () => {
		// Null is unlimited and therefore the top of the ladder. A plan that
		// allowed fewer of something than the one below it would make an upgrade a
		// downgrade, and the refusal would name a plan that does not help.
		for (const limit of Object.keys(COUNTED_PLAN_LIMITS) as CountedPlanLimit[]) {
			const ladder = PLAN_NAMES.map((plan) => planLimits(plan)[limit])

			for (let index = 1; index < ladder.length; index += 1) {
				const below = ladder[index - 1]
				const above = ladder[index]
				if (below === null) expect(above).toBeNull()
				else if (above !== null) expect(above).toBeGreaterThanOrEqual(below!)
			}
		}
	})

	it("keeps API keys and data sources behind a per-seat plan", () => {
		// One is unattended spend, the other a credential to a customer's own
		// database. Neither is extended to an account that has never paid.
		for (const plan of ["free", "starter"] as const) {
			expect(planLimits(plan).apiKeysEnabled).toBe(false)
			expect(planLimits(plan).dataSourcesEnabled).toBe(false)
		}
		for (const plan of ["pro", "team", "enterprise"] as const) {
			expect(planLimits(plan).apiKeysEnabled).toBe(true)
			expect(planLimits(plan).dataSourcesEnabled).toBe(true)
		}
	})

	it("opens automation at the cheapest paid plan", () => {
		expect(planLimits("free").automationEnabled).toBe(false)
		expect(planLimits("starter").automationEnabled).toBe(true)
	})

	it("names a plan that lifts each boundary the cheaper plans have", () => {
		// The refusal text is built from these, and an upgrade prompt that names
		// nothing is a refusal the customer cannot act on.
		expect(planRaisingLimit("free", "knowledgeBaseLimit")).toBe("starter")
		expect(planRaisingLimit("starter", "agentLimit")).toBe("pro")
		expect(planUnlockingFeature("automationEnabled")).toBe("starter")
		expect(planUnlockingFeature("apiKeysEnabled")).toBe("pro")
	})

	it("has nothing to offer a plan that is already unlimited", () => {
		expect(planRaisingLimit("team", "agentLimit")).toBeNull()
		expect(planRaisingLimit("enterprise", "knowledgeBaseLimit")).toBeNull()
	})
})

describe("the commercial rules the numbers encode", () => {
	it("prices every top-up pack above the credits a subscription bundles", () => {
		// Pro is $29 for 2M credits — about $14.50 per million. If a pack were
		// cheaper than that, the rational customer would sit on the free plan and
		// buy packs forever, and the subscription would stop being the product.
		const proPerMillion = 29 / (planLimits("pro").creditsPerSeat! / 1_000_000)

		for (const pack of Object.values(TOPUP_PACKS)) {
			expect(pack.priceUsd / (pack.credits / 1_000_000)).toBeGreaterThan(proPerMillion)
		}
	})

	it("makes a bigger top-up pack cheaper per credit than a smaller one", () => {
		const perMillion = Object.values(TOPUP_PACKS)
			.sort((a, b) => a.credits - b.credits)
			.map((pack) => pack.priceUsd / (pack.credits / 1_000_000))

		for (let index = 1; index < perMillion.length; index += 1) {
			expect(perMillion[index]!).toBeLessThan(perMillion[index - 1]!)
		}
	})

	it("funds the free plan once and never again", () => {
		// Free is a trial: the signup grant is the entire free tier, and no plan
		// rule may quietly turn it back into a standing monthly allowance.
		expect(SIGNUP_GRANT_CREDITS).toBe(20_000)
		expect(planLimits("free").flatCredits).toBeNull()
		expect(planLimits("free").creditsPerSeat).toBeNull()
	})
})

/**
 * A named amount is the one price in the catalogue a customer types themselves,
 * so both halves of it are tested: what the money buys, and what the boundary
 * lets through. The conversion decides what the webhook grants — it is written
 * into the checkout session's metadata before Stripe is ever called — and the
 * schema is the only thing standing between a typo and a card charge.
 */
describe("creditsForCustomTopupUsd", () => {
	it("sells a custom amount at exactly the smallest pack's price", () => {
		// $39 buys a million either way. If this ever diverged, the same money would
		// buy a different number of credits depending on which button was pressed.
		expect(creditsForCustomTopupUsd(39)).toBe(1_000_000)
		expect(creditsForCustomTopupUsd(39)).toBe(TOPUP_PACKS["1m"].credits)
	})

	it("never undercuts the volume packs", () => {
		// The 5M and 15M packs exist to be the cheaper way to buy in bulk. A custom
		// amount matching their price must buy fewer credits, not more.
		expect(creditsForCustomTopupUsd(TOPUP_PACKS["5m"].priceUsd)).toBeLessThan(
			TOPUP_PACKS["5m"].credits,
		)
		expect(creditsForCustomTopupUsd(TOPUP_PACKS["15m"].priceUsd)).toBeLessThan(
			TOPUP_PACKS["15m"].credits,
		)
	})

	it("rounds down to a whole credit", () => {
		// $10 is 256410.25… credits. The ledger holds whole credits, and rounding up
		// would grant a fraction nobody paid for.
		expect(creditsForCustomTopupUsd(CUSTOM_TOPUP_MIN_USD)).toBe(256_410)
		expect(Number.isInteger(creditsForCustomTopupUsd(137))).toBe(true)
	})
})

describe("the custom top-up boundary", () => {
	const parse = (amountUsd: number) => createCheckoutSchema.safeParse({ amountUsd })

	it("accepts the minimum exactly", () => {
		expect(parse(CUSTOM_TOPUP_MIN_USD).success).toBe(true)
	})

	it("refuses a cent below the minimum", () => {
		// Stripe's $0.30 + 2.9% is 5.8% of a $10 payment and worse below it.
		const result = parse(CUSTOM_TOPUP_MIN_USD - 0.01)
		expect(result.success).toBe(false)
		expect(JSON.stringify(result.error?.issues)).toContain(`$${CUSTOM_TOPUP_MIN_USD}`)
	})

	it("accepts the maximum exactly", () => {
		expect(parse(CUSTOM_TOPUP_MAX_USD).success).toBe(true)
	})

	it("refuses a dollar above the maximum", () => {
		const result = parse(CUSTOM_TOPUP_MAX_USD + 1)
		expect(result.success).toBe(false)
		expect(JSON.stringify(result.error?.issues)).toContain(`$${CUSTOM_TOPUP_MAX_USD}`)
	})

	it("refuses a fraction of a dollar inside the range", () => {
		expect(parse(49.5).success).toBe(false)
	})

	it("refuses a custom amount alongside a pack or a plan", () => {
		// One checkout buys one thing. Two fields set would leave the controller to
		// pick, and it would silently pick the first.
		expect(
			createCheckoutSchema.safeParse({ pack: "1m", amountUsd: 50 }).success,
		).toBe(false)
		expect(
			createCheckoutSchema.safeParse({ plan: "pro", amountUsd: 50 }).success,
		).toBe(false)
		expect(createCheckoutSchema.safeParse({}).success).toBe(false)
	})
})

describe("isPlanName", () => {
	it("accepts the plans the product sells", () => {
		for (const plan of PLAN_NAMES) {
			expect(isPlanName(plan)).toBe(true)
		}
	})

	it("rejects anything else that arrives as a plan", () => {
		// It guards a value read back out of the subscription row and off an admin
		// request, and it narrows the type that indexes PLAN_LIMITS.
		expect(isPlanName("growth")).toBe(false)
		expect(isPlanName("FREE")).toBe(false)
		expect(isPlanName("")).toBe(false)
	})
})

describe("isTopupPackId", () => {
	it("accepts the packs on sale", () => {
		expect(isTopupPackId("1m")).toBe(true)
		expect(isTopupPackId("15m")).toBe(true)
	})

	it("rejects a pack that is not on sale", () => {
		expect(isTopupPackId("100m")).toBe(false)
		expect(isTopupPackId("")).toBe(false)
		expect(isTopupPackId("1M")).toBe(false)
	})
})

/**
 * What a workspace bills in a month. These are the numbers the revenue report
 * adds up, so a plan whose price moves without this test moving is a plan that
 * silently restates the run rate.
 */
describe("monthlyPriceUsd", () => {
	it("bills free at nothing, however many seats it somehow has", () => {
		expect(monthlyPriceUsd("free", 1)).toBe(0)
		expect(monthlyPriceUsd("free", 4)).toBe(0)
	})

	it("bills starter flat, whatever seat count it is asked about", () => {
		// Single-seat and flat: the seat arithmetic must not reach it at all, or a
		// workspace that somehow held two seats would be invoiced for a second one
		// that was never sold.
		expect(monthlyPriceUsd("starter", 0)).toBe(9)
		expect(monthlyPriceUsd("starter", 1)).toBe(9)
		expect(monthlyPriceUsd("starter", 4)).toBe(9)
	})

	it("bills pro per occupied seat", () => {
		expect(monthlyPriceUsd("pro", 1)).toBe(29)
		expect(monthlyPriceUsd("pro", 4)).toBe(116)
	})

	it("counts an empty workspace as one seat rather than none", () => {
		// A subscription with no members is still being charged for one.
		expect(monthlyPriceUsd("pro", 0)).toBe(29)
	})

	it("bills team flat up to its included seats, then per extra seat", () => {
		expect(monthlyPriceUsd("team", 3)).toBe(99)
		expect(monthlyPriceUsd("team", 5)).toBe(99)
		expect(monthlyPriceUsd("team", 7)).toBe(99 + 2 * 19)
	})

	it("refuses to price enterprise", () => {
		// Invoiced by hand. A zero here would quietly report a paying customer as
		// contributing nothing.
		expect(monthlyPriceUsd("enterprise", 40)).toBeNull()
	})
})

describe("topupPackByCredits", () => {
	it("finds the pack a credit amount was bought as", () => {
		expect(topupPackByCredits(1_000_000)?.priceUsd).toBe(39)
		expect(topupPackByCredits(15_000_000)?.priceUsd).toBe(450)
	})

	it("does not price an amount no pack sells", () => {
		expect(topupPackByCredits(50_000)).toBeUndefined()
	})
})
