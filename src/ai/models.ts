import type { ModelTier } from "../modules/billing/plans"

/**
 * The built-in model catalogue: what exists, what it can do, which plan tier it
 * belongs to, and what the provider charges for it.
 *
 * This list ships with the code so a fresh database is usable before anybody
 * opens the admin console. It is not the whole catalogue any more — a
 * `provider_model` row with the same `(provider, model)` key replaces the entry
 * here, and a row with a new key adds one. `src/ai/catalogue.ts` performs that
 * merge and is what every reader should call; this module is the seed.
 *
 * Two readers of the merged result — `modules/usage/pricing.ts` turns rates into
 * credits, `modules/model` decides what a workspace may select. Keeping them
 * fed from one place is deliberate: a model that can be picked but has no price,
 * or has a price but cannot be picked, is a billing hole.
 */
export type ModelCapability = "chat" | "embedding"

export interface ModelDefinition {
	provider: string
	model: string
	capability: ModelCapability
	tier: ModelTier
	/** Provider list price in USD per 1M tokens. Verify before a billing release. */
	rates: { input: number; output: number; embedding: number }
	/** Context window in tokens, for the model picker. */
	contextWindow?: number
	/**
	 * Vector width, embedding models only. It selects the Qdrant collection a
	 * knowledge base indexes into, so a wrong number here fails indexing outright
	 * rather than quietly degrading retrieval.
	 */
	embeddingDimensions?: number
}

export const MODELS: ModelDefinition[] = [
	{
		provider: "anthropic",
		model: "claude-opus-5",
		capability: "chat",
		tier: "premium",
		rates: { input: 15, output: 75, embedding: 0 },
		contextWindow: 200_000,
	},
	{
		provider: "anthropic",
		model: "claude-sonnet-5",
		capability: "chat",
		tier: "premium",
		rates: { input: 3, output: 15, embedding: 0 },
		contextWindow: 200_000,
	},
	{
		provider: "anthropic",
		model: "claude-haiku-4-5",
		capability: "chat",
		tier: "economy",
		rates: { input: 1, output: 5, embedding: 0 },
		contextWindow: 200_000,
	},
	{
		provider: "openai",
		model: "gpt-4o",
		capability: "chat",
		tier: "premium",
		rates: { input: 2.5, output: 10, embedding: 0 },
		contextWindow: 128_000,
	},
	{
		provider: "openai",
		model: "gpt-4o-mini",
		capability: "chat",
		tier: "economy",
		rates: { input: 0.15, output: 0.6, embedding: 0 },
		contextWindow: 128_000,
	},
	{
		provider: "google",
		model: "gemini-2.5-pro",
		capability: "chat",
		tier: "premium",
		rates: { input: 1.25, output: 10, embedding: 0 },
		contextWindow: 1_000_000,
	},
	{
		provider: "google",
		model: "gemini-2.5-flash",
		capability: "chat",
		tier: "economy",
		rates: { input: 0.3, output: 2.5, embedding: 0 },
		contextWindow: 1_000_000,
	},
	// Embedding models are economy on purpose: the free tier has to be able to
	// upload and index documents, or it cannot show what the product does.
	{
		provider: "openai",
		model: "text-embedding-3-small",
		capability: "embedding",
		tier: "economy",
		rates: { input: 0, output: 0, embedding: 0.02 },
		embeddingDimensions: 1536,
	},
	{
		provider: "openai",
		model: "text-embedding-3-large",
		capability: "embedding",
		tier: "economy",
		rates: { input: 0, output: 0, embedding: 0.13 },
		embeddingDimensions: 3072,
	},
	{
		provider: "google",
		model: "gemini-embedding-001",
		capability: "embedding",
		tier: "economy",
		rates: { input: 0, output: 0, embedding: 0.15 },
		embeddingDimensions: 3072,
	},
]

/** Fallbacks for a workspace that has never chosen. Economy, so free works out of the box. */
export const DEFAULT_CHAT = { provider: "anthropic", model: "claude-haiku-4-5" } as const
export const DEFAULT_EMBEDDING = {
	provider: "openai",
	model: "text-embedding-3-small",
} as const

export function modelKey(provider: string, model: string): string {
	return `${provider}:${model}`
}
