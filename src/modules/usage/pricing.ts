import { findModel } from "../../ai/models"
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
 */
export const PRICING_VERSION = "2026-08-29" as const

/** USD per million input tokens of the baseline model. 1 credit == 1 such token. */
const BASELINE_USD_PER_MILLION = 3

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

export interface PricedUsage {
	credits: number
	pricingVersion: string
}

export function priceUsage(provider: string, model: string, tokens: TokenCounts): PricedUsage {
	const rates = findModel(provider, model)?.rates ?? DEFAULT_RATES

	const usd =
		((tokens.inputTokens ?? 0) * rates.input +
			(tokens.outputTokens ?? 0) * rates.output +
			(tokens.embeddingTokens ?? 0) * rates.embedding) /
		1_000_000

	// Ledger scale is numeric(14,4); round here so the credits stored on the
	// usage row and the credits deducted from the balance are the same number.
	const credits = Math.round((usd / BASELINE_USD_PER_MILLION) * 1_000_000 * 10_000) / 10_000

	return { credits, pricingVersion: PRICING_VERSION }
}

export function modelTier(provider: string, model: string): ModelTier {
	return findModel(provider, model)?.tier ?? DEFAULT_TIER
}
