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
export type ModelCapability = "chat" | "embedding" | "rerank"

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
	 * Whether the model reads images in a user message.
	 *
	 * Deliberately a flag rather than a fourth `ModelCapability`. A vision model
	 * is still a chat model: `capability` chooses the code path, `vision` only
	 * changes the payload sent down it. The capability set is also mirrored
	 * outside this file as a hard three-value enum — a Postgres CHECK constraint
	 * on `provider_model` and a `z.enum` in the frontend's model service — so a
	 * fourth value would fail the constraint on write and throw on parse in every
	 * model picker at once, which is not what "this model can see" should cost.
	 */
	vision?: boolean
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
		vision: true,
	},
	{
		provider: "anthropic",
		model: "claude-sonnet-5",
		capability: "chat",
		tier: "premium",
		rates: { input: 3, output: 15, embedding: 0 },
		contextWindow: 200_000,
		vision: true,
	},
	{
		provider: "anthropic",
		model: "claude-haiku-4-5",
		capability: "chat",
		tier: "economy",
		rates: { input: 1, output: 5, embedding: 0 },
		contextWindow: 200_000,
		vision: true,
	},
	{
		provider: "openai",
		model: "gpt-4o",
		capability: "chat",
		tier: "premium",
		rates: { input: 2.5, output: 10, embedding: 0 },
		contextWindow: 128_000,
		vision: true,
	},
	{
		provider: "openai",
		model: "gpt-4o-mini",
		capability: "chat",
		tier: "economy",
		rates: { input: 0.15, output: 0.6, embedding: 0 },
		contextWindow: 128_000,
		vision: true,
	},
	{
		provider: "google",
		model: "gemini-2.5-pro",
		capability: "chat",
		tier: "premium",
		rates: { input: 1.25, output: 10, embedding: 0 },
		contextWindow: 1_000_000,
		vision: true,
	},
	{
		provider: "google",
		model: "gemini-2.5-flash",
		capability: "chat",
		tier: "economy",
		rates: { input: 0.3, output: 2.5, embedding: 0 },
		contextWindow: 1_000_000,
		vision: true,
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
	/**
	 * OpenRouter embedding models.
	 *
	 * Only embeddings are shipped for this provider, and only the four whose
	 * price *and* native vector width could both be confirmed. A knowledge base
	 * freezes the width at creation and indexing fails outright if the vectors
	 * come back a different size, so a guessed number here is worse than an
	 * absent entry — which is why `voyageai/voyage-4` and the Gemini embedding
	 * models, both of which publish a *range* of widths, are not in this list.
	 *
	 * Its chat models are deliberately absent. OpenRouter proxies hundreds of
	 * them and the list changes weekly; a snapshot compiled into the build would
	 * be stale on arrival and price a customer's turns wrongly. **Import models**
	 * in the admin console pulls them instead, priced from OpenRouter's own
	 * `/models` response — the numbers the vendor will actually invoice, rather
	 * than numbers copied into this file by hand.
	 *
	 * Prices verified against openrouter.ai on 2026-09-06, in USD per million
	 * tokens. OpenRouter takes a margin over the upstream vendor, so these are
	 * not the same numbers as the direct entries above.
	 */
	{
		provider: "openrouter",
		model: "openai/text-embedding-3-small",
		capability: "embedding",
		tier: "economy",
		rates: { input: 0, output: 0, embedding: 0.02 },
		embeddingDimensions: 1536,
	},
	{
		provider: "openrouter",
		model: "openai/text-embedding-3-large",
		capability: "embedding",
		tier: "economy",
		rates: { input: 0, output: 0, embedding: 0.13 },
		embeddingDimensions: 3072,
	},
	{
		provider: "openrouter",
		model: "baai/bge-m3",
		capability: "embedding",
		tier: "economy",
		rates: { input: 0, output: 0, embedding: 0.01 },
		embeddingDimensions: 1024,
	},
	{
		provider: "openrouter",
		model: "mistralai/mistral-embed-2312",
		capability: "embedding",
		tier: "economy",
		rates: { input: 0, output: 0, embedding: 0.1 },
		embeddingDimensions: 1024,
	},
	/**
	 * Rerankers. Providers price these per search rather than per token, so the
	 * rate is carried in the `input` column as a token-equivalent: a rerank
	 * request bills the passages it scored, and the numbers below are each
	 * vendor's per-1k-search price spread over a 512-token passage. It is an
	 * approximation and knowingly so — verify before a billing release, like
	 * every other rate here.
	 */
	{
		provider: "cohere",
		model: "rerank-v3.5",
		capability: "rerank",
		tier: "economy",
		rates: { input: 4, output: 0, embedding: 0 },
		contextWindow: 4_096,
	},
	{
		provider: "voyage",
		model: "rerank-2.5",
		capability: "rerank",
		tier: "economy",
		rates: { input: 0.05, output: 0, embedding: 0 },
		contextWindow: 16_000,
	},
	{
		provider: "jina",
		model: "jina-reranker-v2-base-multilingual",
		capability: "rerank",
		tier: "economy",
		rates: { input: 0.02, output: 0, embedding: 0 },
		contextWindow: 8_192,
	},
]

/** Fallbacks for a workspace that has never chosen. Economy, so free works out of the box. */
export const DEFAULT_CHAT = { provider: "anthropic", model: "claude-haiku-4-5" } as const
export const DEFAULT_EMBEDDING = {
	provider: "openai",
	model: "text-embedding-3-small",
} as const

/**
 * Which plan tier a model belongs to, from what it costs.
 *
 * Needed because an imported catalogue carries prices but no tier — the vendor
 * has no idea how Ragenta's plans are drawn. The thresholds are chosen to
 * reproduce the hand-written entries above rather than invented: Haiku (1 / 5)
 * and gpt-4o-mini (0.15 / 0.6) come out economy, Sonnet (3 / 15) and gpt-4o
 * (2.5 / 10) come out premium. A model at or below both numbers is economy.
 *
 * Erring towards `premium` is the safe direction: it narrows who may run a
 * model, where the opposite would let an expensive one onto a cheaper plan.
 */
const ECONOMY_INPUT_CEILING = 1
const ECONOMY_OUTPUT_CEILING = 5

export function tierFor(inputPerMillion: number, outputPerMillion: number): ModelTier {
	return inputPerMillion <= ECONOMY_INPUT_CEILING &&
		outputPerMillion <= ECONOMY_OUTPUT_CEILING
		? "economy"
		: "premium"
}

export function modelKey(provider: string, model: string): string {
	return `${provider}:${model}`
}
