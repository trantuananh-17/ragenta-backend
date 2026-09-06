import { anthropicClient } from "./anthropic"
import { googleClient } from "./google"
import { createOpenAiCompatible, openaiClient } from "./openai"
import { openrouterClient } from "./openrouter"
import { cohereClient, jinaClient, voyageClient } from "./rerankers"
import type { ProviderClient } from "./types"

/**
 * Every provider Ragenta knows about, and which of them it can actually call.
 *
 * A provider with a `client` has an adapter and works the moment a key is
 * stored. One without appears in the admin console with no adapter and no
 * models, because listing it is useful — it says the shape of the roadmap —
 * while pretending a key would do something is not.
 *
 * The OpenAI-compatible group is not a shortcut: DeepSeek, Groq, xAI, Mistral
 * and Ollama all publish the same chat-completions contract, so one adapter
 * with a different base URL is the honest implementation. Where a deployment's
 * particular endpoint differs, the connection check is what says so.
 */
export interface ProviderDescriptor {
	id: string
	name: string
	description: string
	/** Undefined = declared but not callable. */
	client?: ProviderClient
	/** Shown next to the key field so an operator knows what they are pasting. */
	keyHint: string
	/** True when the base URL is not optional — a self-hosted server has no default host. */
	requiresBaseUrl?: boolean
}

export const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
	{
		id: "anthropic",
		name: "Anthropic",
		description: "Claude models. Chat only — Anthropic sells no embedding model.",
		client: anthropicClient,
		keyHint: "sk-ant-...",
	},
	{
		id: "openai",
		name: "OpenAI",
		description: "GPT chat models and the text-embedding-3 family.",
		client: openaiClient,
		keyHint: "sk-...",
	},
	{
		id: "google",
		name: "Google",
		description: "Gemini chat models and gemini-embedding.",
		client: googleClient,
		keyHint: "AIza...",
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		description:
			"A gateway to hundreds of models from every vendor, behind one key and one bill. Chat and embeddings both work, so one key covers the whole RAG path. Model ids are namespaced — `openai/gpt-4o`, not `gpt-4o`. Use Import models to pull its catalogue with the prices OpenRouter itself publishes, rather than shipping a snapshot that would be stale on arrival.",
		client: openrouterClient,
		keyHint: "sk-or-v1-...",
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		description: "OpenAI-compatible endpoint at api.deepseek.com.",
		client: createOpenAiCompatible("deepseek", "https://api.deepseek.com/v1"),
		keyHint: "sk-...",
	},
	{
		id: "groq",
		name: "Groq",
		description: "OpenAI-compatible endpoint, open-weight models at low latency.",
		client: createOpenAiCompatible("groq", "https://api.groq.com/openai/v1"),
		keyHint: "gsk_...",
	},
	{
		id: "xai",
		name: "xAI",
		description: "Grok models over an OpenAI-compatible endpoint.",
		client: createOpenAiCompatible("xai", "https://api.x.ai/v1"),
		keyHint: "xai-...",
	},
	{
		id: "mistral",
		name: "Mistral",
		description: "OpenAI-compatible endpoint, chat and embeddings.",
		client: createOpenAiCompatible("mistral", "https://api.mistral.ai/v1"),
		keyHint: "...",
	},
	{
		id: "ollama",
		name: "Ollama",
		description:
			"A self-hosted model server. Point the base URL at its OpenAI-compatible route, e.g. http://ollama:11434/v1.",
		client: createOpenAiCompatible("ollama", "http://127.0.0.1:11434/v1"),
		keyHint: "any value — Ollama ignores it",
		requiresBaseUrl: true,
	},
	{
		id: "azure-openai",
		name: "Azure OpenAI",
		description:
			"Not implemented. Azure addresses models by deployment name and pins an api-version, which the OpenAI adapter does not do.",
		keyHint: "azure key",
		requiresBaseUrl: true,
	},
	{
		id: "cohere",
		name: "Cohere",
		description:
			"Reranking only. Its chat and embed APIs share no shape with the three above, and Ragenta does not need them.",
		client: cohereClient,
		keyHint: "...",
	},
	{
		id: "voyage",
		name: "Voyage AI",
		description: "Reranking only. Its embedding API is not wired in.",
		client: voyageClient,
		keyHint: "pa-...",
	},
	{
		id: "jina",
		name: "Jina AI",
		description: "Reranking only. Multilingual, which matters for a Vietnamese knowledge base.",
		client: jinaClient,
		keyHint: "jina_...",
	},
]

const BY_ID = new Map(PROVIDER_DESCRIPTORS.map((entry) => [entry.id, entry]))

export function findProvider(id: string): ProviderDescriptor | undefined {
	return BY_ID.get(id)
}

export function isKnownProvider(id: string): boolean {
	return BY_ID.has(id)
}

/** The adapter for a provider, or undefined when this deployment cannot call it. */
export function providerClient(id: string): ProviderClient | undefined {
	return BY_ID.get(id)?.client
}

/**
 * Every capability on `ProviderClient` is optional, so a caller that is about to
 * generate needs the method's presence in the *type*, not just a runtime check —
 * otherwise it carries a `client` it has already proven can chat and has to
 * re-prove it at every use.
 */
export type ChatCapableClient = ProviderClient & Required<Pick<ProviderClient, "streamChat">>

export function chatCapableClient(id: string): ChatCapableClient | undefined {
	const client = BY_ID.get(id)?.client
	return client?.streamChat ? (client as ChatCapableClient) : undefined
}

export * from "./types"
