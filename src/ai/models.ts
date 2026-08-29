import type { ModelTier } from "../modules/billing/plans"

/**
 * The model catalogue: what exists, what it can do, which plan tier it belongs
 * to, and what the provider charges for it.
 *
 * One table, two readers — `modules/usage/pricing.ts` turns the rates into
 * credits, `modules/model` decides what a workspace may select. Keeping them in
 * one place is deliberate: a model that can be picked but has no price, or has a
 * price but cannot be picked, is a billing hole.
 *
 * Ragenta holds the provider keys and customers spend credits, so there is no
 * per-workspace credential anywhere in the system — only a per-workspace
 * *selection* from this list.
 */
export type ProviderName = "openai" | "anthropic" | "google"

export const PROVIDERS: ProviderName[] = ["openai", "anthropic", "google"]

export type ModelCapability = "chat" | "embedding"

export interface ModelDefinition {
	provider: ProviderName
	model: string
	capability: ModelCapability
	tier: ModelTier
	/** Provider list price in USD per 1M tokens. Verify before a billing release. */
	rates: { input: number; output: number; embedding: number }
	/** Context window in tokens, for the model picker. */
	contextWindow?: number
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
	},
	{
		provider: "openai",
		model: "text-embedding-3-large",
		capability: "embedding",
		tier: "economy",
		rates: { input: 0, output: 0, embedding: 0.13 },
	},
]

/** Fallbacks for a workspace that has never chosen. Economy, so free works out of the box. */
export const DEFAULT_CHAT = { provider: "anthropic", model: "claude-haiku-4-5" } as const
export const DEFAULT_EMBEDDING = {
	provider: "openai",
	model: "text-embedding-3-small",
} as const

const BY_KEY = new Map(MODELS.map((entry) => [`${entry.provider}:${entry.model}`, entry]))

export function findModel(provider: string, model: string): ModelDefinition | undefined {
	return BY_KEY.get(`${provider}:${model}`)
}

export function isProviderName(value: string): value is ProviderName {
	return (PROVIDERS as string[]).includes(value)
}
