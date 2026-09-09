import { describe, expect, it } from "vitest"

import {
	FREE_MONTHLY_CREDITS,
	PLAN_LIMITS,
	PLAN_NAMES,
	SIGNUP_GRANT_CREDITS,
	TOPUP_PACKS,
	creditsForPeriod,
	isPlanName,
	isTopupPackId,
	monthlyPriceUsd,
	planLimits,
	topupPackByCredits,
} from "./plans"

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
	})

	it("schedules nothing for the plans that are not granted on a schedule", () => {
		// Free's allowance belongs to the account, not the workspace, and is
		// granted by `scheduledRefill` under the owner's key. Enterprise is
		// invoiced and topped up by hand. Both must answer null, or the refill job
		// would grant them something every month.
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

	it("gives every paid plan both tiers", () => {
		for (const plan of ["pro", "team", "enterprise"] as const) {
			expect(planLimits(plan).modelTiers).toContain("premium")
			expect(planLimits(plan).modelTiers).toContain("economy")
		}
	})

	it("refuses top-ups on free and allows them everywhere else", () => {
		// Free has no card on file and no subscription behind it; letting it buy
		// packs would make it a standalone pay-as-you-go tier by accident.
		expect(planLimits("free").topupsEnabled).toBe(false)
		for (const plan of ["pro", "team", "enterprise"] as const) {
			expect(planLimits(plan).topupsEnabled).toBe(true)
		}
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

	it("gives a new account its first month twice over", () => {
		// The signup grant lands in the top-up bucket and the monthly allowance in
		// the plan bucket, so a first month is both and every month after is one.
		// Sized together on purpose; changing either alone moves the free tier.
		expect(SIGNUP_GRANT_CREDITS + FREE_MONTHLY_CREDITS).toBe(100_000)
		expect(FREE_MONTHLY_CREDITS).toBe(50_000)
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
		expect(isPlanName("starter")).toBe(false)
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
