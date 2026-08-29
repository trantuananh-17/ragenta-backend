import type { ModelTier } from "../billing/plans"

/**
 * Token → credit conversion.
 *
 * **One credit is one input token of the baseline model** (Sonnet-class, taken
 * as $3 per million). Every other rate is derived from what the model really
 * costs, so credit consumption is proportional to provider cost and our margin
 * per credit is the same whichever model a customer picks. A flat per-token
 * price cannot do this: Opus output costs 500× a gpt-4o-mini input token, so one
 * price is either a giveaway or a loss depending on who is spending it.
 *
 * Usage is priced **at write time** and the resulting credit amount is frozen on
 * the usage row with the `pricingVersion` that produced it (ADR-013). Changing a
 * number here never restates what a workspace was already charged.
 *
 * Rates below are provider list prices in USD per million tokens. Verify them
 * against the providers before a release that touches billing, and bump
 * `PRICING_VERSION` whenever one changes.
 */
export const PRICING_VERSION = "2026-08-29" as const

/** USD per million input tokens of the baseline model. 1 credit == 1 such token. */
const BASELINE_USD_PER_MILLION = 3

interface ModelRate {
	/** USD per 1M tokens, as charged by the provider. */
	input: number
	output: number
	embedding: number
	tier: ModelTier
}

const MODEL_RATES: Record<string, ModelRate> = {
	"anthropic:claude-opus-5": { input: 15, output: 75, embedding: 0, tier: "premium" },
	"anthropic:claude-sonnet-5": { input: 3, output: 15, embedding: 0, tier: "premium" },
	"anthropic:claude-haiku-4-5": { input: 1, output: 5, embedding: 0, tier: "economy" },
	"openai:gpt-4o": { input: 2.5, output: 10, embedding: 0, tier: "premium" },
	"openai:gpt-4o-mini": { input: 0.15, output: 0.6, embedding: 0, tier: "economy" },
	"google:gemini-2.5-pro": { input: 1.25, output: 10, embedding: 0, tier: "premium" },
	"google:gemini-2.5-flash": { input: 0.3, output: 2.5, embedding: 0, tier: "economy" },
	// Embeddings are economy on purpose: the free tier has to be able to upload
	// and index documents, or it cannot show what the product does.
	"openai:text-embedding-3-small": { input: 0, output: 0, embedding: 0.02, tier: "economy" },
	"openai:text-embedding-3-large": { input: 0, output: 0, embedding: 0.13, tier: "economy" },
}

/**
 * Unknown models are priced at the most expensive rate we carry and treated as
 * premium. An unlisted model must never become a cheaper way to buy compute.
 */
const DEFAULT_RATE: ModelRate = { input: 15, output: 75, embedding: 0.13, tier: "premium" }

function rateFor(provider: string, model: string): ModelRate {
	return MODEL_RATES[`${provider}:${model}`] ?? DEFAULT_RATE
}

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
	const rate = rateFor(provider, model)

	const usd =
		((tokens.inputTokens ?? 0) * rate.input +
			(tokens.outputTokens ?? 0) * rate.output +
			(tokens.embeddingTokens ?? 0) * rate.embedding) /
		1_000_000

	// Ledger scale is numeric(14,4); round here so the credits stored on the
	// usage row and the credits deducted from the balance are the same number.
	const credits = Math.round((usd / BASELINE_USD_PER_MILLION) * 1_000_000 * 10_000) / 10_000

	return { credits, pricingVersion: PRICING_VERSION }
}

export function modelTier(provider: string, model: string): ModelTier {
	return rateFor(provider, model).tier
}

export function isKnownModel(provider: string, model: string): boolean {
	return `${provider}:${model}` in MODEL_RATES
}

/** The catalogue a model picker renders, with the tier that gates each entry. */
export function listModels() {
	return Object.entries(MODEL_RATES).map(([key, rate]) => {
		const [provider = "", model = ""] = key.split(":")
		return { provider, model, tier: rate.tier }
	})
}
