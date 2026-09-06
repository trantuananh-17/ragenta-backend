import { AppError } from "../../shared/errors"

export interface ProviderCredential {
	apiKey: string
	/** Overrides the client's default host. Set for gateways and self-hosted servers. */
	baseUrl?: string
}

export type ChatRole = "system" | "user" | "assistant"

export interface ChatMessage {
	role: ChatRole
	content: string
}

export interface ChatRequest {
	model: string
	messages: ChatMessage[]
	temperature?: number
	maxTokens?: number
	signal?: AbortSignal
}

export interface TokenUsage {
	inputTokens: number
	outputTokens: number
}

export interface ChatResult {
	text: string
	usage: TokenUsage
	finishReason: string
}

/**
 * A streamed answer. `done` always arrives last and carries the provider's own
 * token counts — usage is charged from those, never from a local estimate, so
 * the stream cannot end without the numbers needed to bill it.
 */
export type ChatStreamEvent =
	| { type: "delta"; text: string }
	| { type: "done"; usage: TokenUsage; finishReason: string }

export interface EmbedRequest {
	model: string
	input: string[]
	/** Requested vector width, for models that support shortening (OpenAI v3). */
	dimensions?: number
}

export interface EmbedResult {
	vectors: number[][]
	embeddingTokens: number
}

export interface CheckResult {
	ok: boolean
	/** What was verified, in words an administrator can act on. */
	detail: string
	/** Model ids the provider reported, when the check can list them. */
	models?: string[]
}

export interface RerankRequest {
	model: string
	query: string
	documents: string[]
	topN: number
	signal?: AbortSignal
}

export interface RerankResult {
	/** Index into the request's `documents`, with the model's own relevance score. */
	scores: Array<{ index: number; score: number }>
	/**
	 * What the provider says it charged for, in tokens. Rerankers price per
	 * search rather than per token and most report nothing, so this is usually
	 * the local estimate — `estimated` says which.
	 */
	tokens: number
	estimated: boolean
}

/**
 * Every capability is optional because a provider may have only one. Cohere,
 * Voyage and Jina sell reranking and nothing Ragenta needs; requiring them to
 * declare a `chat` method would mean writing three that throw, and a method that
 * exists but always fails is worse than one that is absent — the caller can test
 * for absent.
 */
/**
 * A model a provider says it has, priced by the provider itself.
 *
 * This is the difference between a catalogue that is right and one that was
 * right when someone typed it. Every rate in `src/ai/models.ts` is a number
 * copied by hand and is carried as known debt; a provider that publishes its own
 * prices can be asked instead, and a gateway proxying hundreds of models that
 * change weekly can only be handled that way.
 */
export interface ListedModel {
	id: string
	capability: "chat" | "embedding" | "rerank"
	/** USD per million tokens, converted from whatever unit the provider quotes. */
	inputPerMillion: number
	outputPerMillion: number
	embeddingPerMillion: number
	contextWindow?: number
	embeddingDimensions?: number
}

export interface ProviderClient {
	readonly id: string
	readonly defaultBaseUrl: string
	chat?(credential: ProviderCredential, request: ChatRequest): Promise<ChatResult>
	streamChat?(
		credential: ProviderCredential,
		request: ChatRequest,
	): AsyncGenerator<ChatStreamEvent>
	embed?(credential: ProviderCredential, request: EmbedRequest): Promise<EmbedResult>
	rerank?(credential: ProviderCredential, request: RerankRequest): Promise<RerankResult>
	/**
	 * The provider's own catalogue, with its own prices. Present only where the
	 * provider publishes prices machine-readably — a list of model names with no
	 * rates is worse than nothing here, because a model priced at zero is a model
	 * customers run for free.
	 */
	listModels?(credential: ProviderCredential): Promise<ListedModel[]>
	/** One cheap live call proving the key works. Throws ProviderError when it does not. */
	check(credential: ProviderCredential): Promise<CheckResult>
}

/**
 * An upstream provider failed. 502 rather than 500: the request was well formed
 * and Ragenta is working — somebody else's service is not, and the distinction
 * matters to whoever is reading the logs at 3am.
 *
 * The message is the provider's, trimmed. Provider error bodies echo request
 * parameters but never the key, and `sanitize` drops anything key-shaped
 * regardless, because a message that leaks a credential into a log is worse
 * than one that is vague.
 */
export class ProviderError extends AppError {
	constructor(provider: string, message: string, details?: unknown) {
		super("PROVIDER_ERROR", `${provider}: ${sanitize(message)}`, 502, details)
	}
}

const KEY_SHAPED = /\b(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+\S+)/g

export function sanitize(message: string): string {
	return message.replace(KEY_SHAPED, "[redacted]").slice(0, 500)
}

/** Reads a provider's error body without ever throwing a second error from the handler. */
export async function readError(provider: string, response: Response): Promise<ProviderError> {
	let message = `${response.status} ${response.statusText}`
	try {
		const body = await response.text()
		if (body) message = `${message} — ${body}`
	} catch {
		// A body that cannot be read tells us nothing extra; the status still does.
	}
	return new ProviderError(provider, message, { status: response.status })
}

/**
 * Splits a provider's SSE stream into `data:` payloads.
 *
 * Written out rather than pulled from a library because all three providers
 * emit the same shape and the whole rule is "buffer until a blank line". A
 * chunk can split a line anywhere, which is the bug this exists to not have.
 */
export async function* sseLines(response: Response): AsyncGenerator<string> {
	if (!response.body) return
	const decoder = new TextDecoder()
	let buffer = ""

	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true })
		let index = buffer.indexOf("\n")
		while (index !== -1) {
			const line = buffer.slice(0, index).trim()
			buffer = buffer.slice(index + 1)
			if (line.startsWith("data:")) yield line.slice(5).trim()
			index = buffer.indexOf("\n")
		}
	}

	const tail = buffer.trim()
	if (tail.startsWith("data:")) yield tail.slice(5).trim()
}
