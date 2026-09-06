import { AppError } from "../../shared/errors"

export interface ProviderCredential {
	apiKey: string
	/** Overrides the client's default host. Set for gateways and self-hosted servers. */
	baseUrl?: string
}

export type ChatRole = "system" | "user" | "assistant" | "tool"

/**
 * One call the model asked for.
 *
 * `arguments` is JSON **text**, exactly as the model produced it, not a parsed
 * object: a model can emit arguments that do not parse, and that is the caller's
 * problem to report to the model rather than the adapter's to throw over. The id
 * is the provider's own where it has one — Google does not, so its adapter
 * synthesises one — and a tool result must quote it back.
 */
export interface ToolCall {
	id: string
	name: string
	arguments: string
}

export interface ChatMessage {
	role: ChatRole
	content: string
	/** Set on an assistant message that asked for tools. */
	toolCalls?: ToolCall[]
	/** Set on a `tool` message: which call it answers. */
	toolCallId?: string
	/** Set on a `tool` message: the tool's name, which Anthropic and Google need. */
	name?: string
}

/**
 * A tool offered to the model. `parameters` is a JSON Schema object — the tool
 * registry derives it from the same zod schema it validates arguments against,
 * so what the model is told and what is enforced cannot drift.
 */
export interface ToolDefinition {
	name: string
	description: string
	parameters: Record<string, unknown>
}

export interface ChatRequest {
	model: string
	messages: ChatMessage[]
	temperature?: number
	maxTokens?: number
	signal?: AbortSignal
	/** Absent means the model may not call anything, which is the default. */
	tools?: ToolDefinition[]
	toolChoice?: "auto" | "none"
}

export interface TokenUsage {
	inputTokens: number
	outputTokens: number
}

export interface ChatResult {
	text: string
	/** Empty unless the request offered tools and the model asked for one. */
	toolCalls?: ToolCall[]
	usage: TokenUsage
	finishReason: string
}

/**
 * A streamed answer. `done` always arrives last and carries the provider's own
 * token counts — usage is charged from those, never from a local estimate, so
 * the stream cannot end without the numbers needed to bill it.
 *
 * A `tool_call` is emitted **whole**, once the adapter has assembled it, rather
 * than as argument fragments. All three providers stream those arguments in
 * pieces, and nothing downstream can use half of a JSON object: the runner needs
 * the complete call before it can execute anything, and a UI showing a
 * half-written argument list would be showing noise. Assembling once, in the
 * adapter, is also the only place that knows each provider's fragment shape.
 */
export type ChatStreamEvent =
	| { type: "delta"; text: string }
	| { type: "tool_call"; call: ToolCall }
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
	/**
	 * Whether `chat` and `streamChat` honour `tools`.
	 *
	 * Declared rather than assumed from the API shape: an OpenAI-compatible
	 * gateway may implement chat completions and ignore `tools` entirely, and a
	 * model silently answering in prose when it was asked to call a tool is a
	 * failure nobody can debug from the outside. An agent configured with tools
	 * on a provider that has not declared this is refused when the version is
	 * published, not when it runs.
	 */
	readonly supportsTools?: boolean
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
