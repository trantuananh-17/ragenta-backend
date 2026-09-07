import { findCatalogueModel } from "../../ai/catalogue"
import type { ModelTier } from "../billing/plans"

/**
 * Token → credit conversion.
 *
 * **One credit is one input token of the baseline model** (Sonnet-class, taken
 * as $3 per million). Every other rate comes from `src/ai/models.ts`, which
 * carries what the provider really charges, so credit consumption is
 * proportional to provider cost and our margin per credit is the same whichever
 * model a customer picks. A flat per-token price cannot do this: Opus output
 * costs 500× a gpt-4o-mini input token, so one price is either a giveaway or a
 * loss depending on who is spending it.
 *
 * Usage is priced **at write time** and the resulting credit amount is frozen on
 * the usage row with the `pricingVersion` that produced it (ADR-013). Changing a
 * rate never restates what a workspace was already charged, so bump
 * `PRICING_VERSION` whenever one moves.
 *
 * Rates now come from the merged catalogue, so a rate edited in the admin
 * console prices the very next call. That makes `PRICING_VERSION` a coarser
 * signal than it was — it still marks changes to *this file*, and the frozen
 * `credits` column remains the record of what was actually charged.
 */
export const PRICING_VERSION = "2026-09-07" as const

/** USD per million input tokens of the baseline model. 1 credit == 1 such token. */
const BASELINE_USD_PER_MILLION = 3

/**
 * Unknown models are priced at the most expensive rate we carry and treated as
 * premium. An unlisted model must never become a cheaper way to buy compute.
 */
const DEFAULT_RATES = { input: 15, output: 75, embedding: 0.13 }
const DEFAULT_TIER: ModelTier = "premium"

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

export interface TokenCounts {
	inputTokens?: number
	outputTokens?: number
	embeddingTokens?: number
}

export interface PricedUsage {
	credits: number
	pricingVersion: string
}

/**
 * Ledger scale is numeric(14,4); round here so the credits stored on the usage
 * row and the credits deducted from the balance are the same number.
 */
function toCredits(usd: number): number {
	return Math.round((usd / BASELINE_USD_PER_MILLION) * 1_000_000 * 10_000) / 10_000
}

export async function priceUsage(
	provider: string,
	model: string,
	tokens: TokenCounts,
): Promise<PricedUsage> {
	const rates = (await findCatalogueModel(provider, model))?.rates ?? DEFAULT_RATES

	const usd =
		((tokens.inputTokens ?? 0) * rates.input +
			(tokens.outputTokens ?? 0) * rates.output +
			(tokens.embeddingTokens ?? 0) * rates.embedding) /
		1_000_000

	return { credits: toCredits(usd), pricingVersion: PRICING_VERSION }
}

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

export async function modelTier(provider: string, model: string): Promise<ModelTier> {
	return (await findCatalogueModel(provider, model))?.tier ?? DEFAULT_TIER
}
