import { findCatalogueModel } from "../../ai/catalogue"
import { BASELINE_USD_PER_MILLION, PRICING_VERSION, toCredits } from "./credits"
import type { PricedUsage } from "./credits"

// Re-exported so every caller keeps importing pricing, and only the tests need
// to know the arithmetic moved to a module that loads without an environment.
export { PRICING_VERSION, priceSpeechUsage, toCredits } from "./credits"
export type { PricedUsage, SpeechUnits } from "./credits"
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

/**
 * Unknown models are priced at the most expensive rate we carry and treated as
 * premium. An unlisted model must never become a cheaper way to buy compute.
 */
const DEFAULT_RATES = { input: 15, output: 75, embedding: 0.13 }
const DEFAULT_TIER: ModelTier = "premium"

export interface TokenCounts {
	inputTokens?: number
	outputTokens?: number
	embeddingTokens?: number
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

export async function modelTier(provider: string, model: string): Promise<ModelTier> {
	return (await findCatalogueModel(provider, model))?.tier ?? DEFAULT_TIER
}
