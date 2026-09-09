import { describe, expect, it } from "vitest"

import { BASELINE_USD_PER_MILLION, PRICING_VERSION, priceSpeechUsage } from "./credits"

/**
 * Speech pricing arithmetic, which is the part of this feature that costs real
 * money if it is wrong.
 *
 * The numbers below are worked from the same anchor as every token rate — one
 * credit is one input token of a $3-per-million baseline model — so they double
 * as the documentation of what a minute of audio and a page of speech are
 * actually worth:
 *
 *   60s of transcription = $0.006 = ($0.006 / $3) × 1M = 2,000 credits
 *   1,000 characters of speech = $0.015 = ($0.015 / $3) × 1M = 5,000 credits
 *
 * A change to either list price changes these expectations, which is the point:
 * a rate cannot move without a test saying so.
 */

describe("the dollars beside the credits", () => {
	/**
	 * The two numbers agree today because both come from the same USD figure.
	 * They are stored separately so they may stop agreeing: the day
	 * `BASELINE_USD_PER_MILLION` moves, every row written before it keeps the
	 * dollars it really cost, and deriving them from credits would silently
	 * restate all of them.
	 */
	it("reports the provider price the credits were converted from", () => {
		expect(priceSpeechUsage({ seconds: 60 }).usd).toBe(0.006)
		expect(priceSpeechUsage({ characters: 1_000 }).usd).toBe(0.015)
	})

	it("agrees with the credit conversion while the baseline is unchanged", () => {
		const priced = priceSpeechUsage({ seconds: 300 })
		expect((priced.credits * BASELINE_USD_PER_MILLION) / 1_000_000).toBeCloseTo(priced.usd, 8)
	})

	it("keeps a sub-cent call off zero at the ledger's scale", () => {
		// numeric(16,8): a single second is $0.0001, which eight decimals hold.
		expect(priceSpeechUsage({ seconds: 1 }).usd).toBe(0.0001)
	})
})

describe("priceSpeechUsage", () => {
	it("charges a minute of transcription at the baseline-anchored rate", () => {
		expect(priceSpeechUsage({ seconds: 60 }).credits).toBe(2_000)
		expect(priceSpeechUsage({ seconds: 300 }).credits).toBe(10_000)
	})

	it("prices a single second without losing it to rounding", () => {
		// numeric(14,4) is the ledger's scale, so four decimals survive and a
		// short clip is not silently free.
		expect(priceSpeechUsage({ seconds: 1 }).credits).toBe(33.3333)
	})

	it("charges synthesis per input character", () => {
		expect(priceSpeechUsage({ characters: 1_000_000 }).credits).toBe(5_000_000)
		expect(priceSpeechUsage({ characters: 1_000 }).credits).toBe(5_000)
		expect(priceSpeechUsage({ characters: 1 }).credits).toBe(5)
	})

	it("adds both units when a caller reports both", () => {
		// 90s = 3,000 credits, 200 characters = 1,000 credits.
		expect(priceSpeechUsage({ seconds: 90, characters: 200 }).credits).toBe(4_000)
	})

	it("charges nothing for nothing", () => {
		expect(priceSpeechUsage({}).credits).toBe(0)
		expect(priceSpeechUsage({ seconds: 0 }).credits).toBe(0)
		expect(priceSpeechUsage({ characters: 0 }).credits).toBe(0)
		expect(priceSpeechUsage({ seconds: 0, characters: 0 }).credits).toBe(0)
	})

	it("stamps the pricing version the charge was made under", () => {
		expect(priceSpeechUsage({ seconds: 10 }).pricingVersion).toBe(PRICING_VERSION)
	})
})
