/**
 * The credit scale, and the prices that do not need the catalogue to apply.
 *
 * Split from `pricing.ts` for one concrete reason: that file imports
 * `findCatalogueModel`, which reaches `config/env`, which refuses to load
 * without a database URL. The unit suite runs on a runner that has none
 * (`vitest.config.ts` says so), so a test importing it failed at import — 326
 * tests passing and one whole file unable to start.
 *
 * Everything here is arithmetic over constants. Anything needing a model's rate
 * stays in `pricing.ts` where the catalogue is.
 */

export const PRICING_VERSION = "2026-09-07" as const

/** USD per million input tokens of the baseline model. 1 credit == 1 such token. */
export const BASELINE_USD_PER_MILLION = 3

export interface PricedUsage {
	credits: number
	pricingVersion: string
}

/**
 * Ledger scale is numeric(14,4); round here so the credits stored on the usage
 * row and the credits deducted from the balance are the same number.
 */
export function toCredits(usd: number): number {
	return Math.round((usd / BASELINE_USD_PER_MILLION) * 1_000_000 * 10_000) / 10_000
}

/**
 * Speech is not sold in tokens by anybody, so it cannot go through `priceUsage`:
 * that function falls back to `DEFAULT_RATES` for a model it does not carry, and
 * a transcription pushed through it would be billed at the premium *output token*
 * rate for a unit that is not a token at all.
 *
 * Both numbers are OpenAI's published list prices for the hosted API. Verify
 * before a billing release. A self-hosted sidecar has no per-unit cost to
 * mirror — its real cost is a VM by the hour whether it transcribes one minute
 * or a thousand — so a deployment running one is charging its customers against
 * a price it does not pay, and should set these to its own amortised figures.
 */
const SPEECH_TO_TEXT_USD_PER_MINUTE = 0.006
const TEXT_TO_SPEECH_USD_PER_MILLION_CHARACTERS = 15

/**
 * What a speech call costs, in the units speech is actually sold in.
 *
 * Anchored to the same baseline as every token rate: provider USD is converted
 * through `BASELINE_USD_PER_MILLION`, so a credit spent on a minute of audio and
 * a credit spent on a chat token represent the same real spend and carry the
 * same margin (ADR-015).
 *
 * Both units in one function because one call can be neither or one, never both:
 * transcription reports seconds, synthesis counts characters, and passing zero
 * for the other is the honest way to say "this call had none of that".
 */
export interface SpeechUnits {
	/** Seconds of audio, as the transcription provider reported them. */
	seconds?: number
	/** Characters of input text handed to synthesis. */
	characters?: number
}

export function priceSpeechUsage(units: SpeechUnits): PricedUsage {
	const usd =
		((units.seconds ?? 0) / 60) * SPEECH_TO_TEXT_USD_PER_MINUTE +
		((units.characters ?? 0) / 1_000_000) * TEXT_TO_SPEECH_USD_PER_MILLION_CHARACTERS

	return { credits: toCredits(usd), pricingVersion: PRICING_VERSION }
}
