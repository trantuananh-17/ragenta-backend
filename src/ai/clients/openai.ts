import type {
	ChatMessage,
	ChatRequest,
	ChatResult,
	ChatStreamEvent,
	CheckResult,
	EmbedRequest,
	EmbedResult,
	ProviderClient,
	ProviderCredential,
	TokenUsage,
	ToolCall,
	ToolDefinition,
} from "./types"
import { ProviderError, readError, sseLines } from "./types"

/**
 * The OpenAI chat-completions and embeddings API.
 *
 * Several other providers speak it verbatim — DeepSeek, Groq, xAI, Mistral and
 * Ollama all publish an OpenAI-compatible endpoint — so this client is built
 * around a base URL rather than hardcoding one, and `createOpenAiCompatible`
 * below is how those providers get an adapter without a second implementation.
 * Where their behaviour differs it differs at runtime (a model that does not
 * exist, an embeddings route that is not implemented), and the connection check
 * is what surfaces that per deployment instead of guessing here.
 *
 * Written on fetch rather than the SDK: three endpoints are used in total, and
 * an SDK would be a dependency whose upgrades have to be managed for that.
 */
interface WireToolCall {
	id?: string
	function?: { name?: string; arguments?: string }
}

interface CompletionResponse {
	choices?: {
		message?: { content?: string; tool_calls?: WireToolCall[] }
		finish_reason?: string
	}[]
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

interface StreamChunk {
	choices?: {
		delta?: {
			content?: string
			tool_calls?: (WireToolCall & { index?: number })[]
		}
		finish_reason?: string | null
	}[]
	usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

function usageOf(raw: CompletionResponse["usage"] | StreamChunk["usage"]): TokenUsage {
	return {
		inputTokens: raw?.prompt_tokens ?? 0,
		outputTokens: raw?.completion_tokens ?? 0,
	}
}

/** Ragenta's message shape in the wire shape this API expects. */
function toWireMessages(messages: ChatMessage[]) {
	return messages.map((message) => {
		if (message.role === "tool") {
			return {
				role: "tool" as const,
				tool_call_id: message.toolCallId,
				content: message.content,
			}
		}
		if (message.role === "assistant" && message.toolCalls?.length) {
			return {
				role: "assistant" as const,
				// Null rather than "": the API rejects an assistant message that has
				// neither content nor tool calls, and a model that called a tool
				// without saying anything produces exactly that.
				content: message.content || null,
				tool_calls: message.toolCalls.map((call) => ({
					id: call.id,
					type: "function" as const,
					function: { name: call.name, arguments: call.arguments },
				})),
			}
		}
		if (message.role === "user" && message.images?.length) {
			return {
				role: "user" as const,
				content: [
					// Omitted when absent: an uncaptioned image is the ordinary case,
					// and an empty text part is at best noise and at worst refused by
					// a compatible endpoint that is stricter than OpenAI itself.
					...(message.content ? [{ type: "text" as const, text: message.content }] : []),
					...message.images.map((image) => ({
						type: "image_url" as const,
						image_url: {
							url: `data:${image.mediaType};base64,${image.dataBase64}`,
						},
					})),
				],
			}
		}
		// A message without images stays a plain string. The array form is
		// equivalent for OpenAI itself but not for every compatible endpoint, and
		// there is no reason to make every text-only turn of every conversation
		// the shape that is least widely accepted.
		return { role: message.role, content: message.content }
	})
}

function toWireTools(tools: ToolDefinition[] | undefined) {
	if (!tools?.length) return undefined
	return tools.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}))
}

export function createOpenAiCompatible(
	id: string,
	defaultBaseUrl: string,
	options: {
		supportsEmbeddings?: boolean
		/**
		 * Whether the embeddings route accepts OpenAI's `dimensions` parameter,
		 * which shortens a vector below the model's native width. A gateway that
		 * does not document it either ignores it or rejects the request, and
		 * neither is worth risking for a parameter Ragenta only ever sets to the
		 * width it already recorded. Sending nothing gets the native width, which
		 * `embedTexts` then checks against the catalogue.
		 */
		supportsEmbeddingDimensions?: boolean
		/**
		 * Whether this deployment's endpoint implements `tools`. True for OpenAI
		 * itself and for every gateway Ragenta ships that documents it; set false
		 * for one that does not, so an agent with tools is refused at publish time
		 * rather than quietly answering in prose.
		 */
		supportsTools?: boolean
	} = {},
): ProviderClient {
	const base = (credential: ProviderCredential) =>
		(credential.baseUrl ?? defaultBaseUrl).replace(/\/+$/, "")

	const headers = (credential: ProviderCredential) => ({
		"content-type": "application/json",
		authorization: `Bearer ${credential.apiKey}`,
	})

	const client: ProviderClient = {
		id,
		defaultBaseUrl,
		supportsTools: options.supportsTools !== false,
		// The adapter can send images; whether the model looks at them is a
		// property of the model, not of the endpoint. Every deployment reached
		// through here — OpenRouter, DeepSeek, Groq, xAI, Mistral, Ollama — mixes
		// models that read images with models that cannot, so the per-model
		// `vision` flag in `src/ai/models.ts` is what decides whether one is
		// offered; this only says the wire format is produced.
		supportsVision: true,

		async chat(credential, request: ChatRequest): Promise<ChatResult> {
			const response = await fetch(`${base(credential)}/chat/completions`, {
				method: "POST",
				headers: headers(credential),
				signal: request.signal,
				body: JSON.stringify({
					model: request.model,
					messages: toWireMessages(request.messages),
					temperature: request.temperature,
					max_tokens: request.maxTokens,
					tools: toWireTools(request.tools),
					tool_choice: request.tools?.length ? (request.toolChoice ?? "auto") : undefined,
				}),
			})
			if (!response.ok) throw await readError(id, response)

			const body = (await response.json()) as CompletionResponse
			const choice = body.choices?.[0]
			return {
				text: choice?.message?.content ?? "",
				toolCalls: (choice?.message?.tool_calls ?? [])
					.filter((call) => call.function?.name)
					.map((call, index) => ({
						id: call.id ?? `call_${index}`,
						name: call.function?.name ?? "",
						arguments: call.function?.arguments ?? "{}",
					})),
				usage: usageOf(body.usage),
				finishReason: choice?.finish_reason ?? "stop",
			}
		},

		async *streamChat(credential, request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
			const response = await fetch(`${base(credential)}/chat/completions`, {
				method: "POST",
				headers: headers(credential),
				signal: request.signal,
				body: JSON.stringify({
					model: request.model,
					messages: toWireMessages(request.messages),
					temperature: request.temperature,
					max_tokens: request.maxTokens,
					tools: toWireTools(request.tools),
					tool_choice: request.tools?.length ? (request.toolChoice ?? "auto") : undefined,
					stream: true,
					// Without this the final chunk carries no usage and the turn
					// cannot be billed from the provider's own count.
					stream_options: { include_usage: true },
				}),
			})
			if (!response.ok) throw await readError(id, response)

			let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
			let finishReason = "stop"
			// Tool calls arrive as fragments keyed by position: the first carries
			// the id and the name, later ones append to the argument string. They
			// are assembled here and emitted whole when the stream ends.
			const partial = new Map<number, { id: string; name: string; args: string }>()

			for await (const payload of sseLines(response)) {
				if (payload === "[DONE]") break
				let chunk: StreamChunk
				try {
					chunk = JSON.parse(payload) as StreamChunk
				} catch {
					// A malformed frame mid-stream is not worth failing the answer the
					// user is already reading; the next frame usually parses.
					continue
				}

				if (chunk.usage) usage = usageOf(chunk.usage)
				const choice = chunk.choices?.[0]
				if (choice?.finish_reason) finishReason = choice.finish_reason
				const text = choice?.delta?.content
				if (text) yield { type: "delta", text }

				for (const [position, fragment] of (choice?.delta?.tool_calls ?? []).entries()) {
					const index = fragment.index ?? position
					const existing = partial.get(index) ?? { id: "", name: "", args: "" }
					partial.set(index, {
						id: fragment.id ?? existing.id,
						name: fragment.function?.name ?? existing.name,
						args: existing.args + (fragment.function?.arguments ?? ""),
					})
				}
			}

			for (const [index, call] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
				if (!call.name) continue
				const assembled: ToolCall = {
					id: call.id || `call_${index}`,
					name: call.name,
					arguments: call.args || "{}",
				}
				yield { type: "tool_call", call: assembled }
			}

			yield { type: "done", usage, finishReason }
		},

		async check(credential): Promise<CheckResult> {
			const response = await fetch(`${base(credential)}/models`, {
				headers: headers(credential),
			})
			if (!response.ok) throw await readError(id, response)

			const body = (await response.json()) as { data?: { id?: string }[] }
			const models = (body.data ?? [])
				.map((entry) => entry.id)
				.filter((value): value is string => Boolean(value))

			return {
				ok: true,
				detail: `Key accepted. ${models.length} model${models.length === 1 ? "" : "s"} visible.`,
				models: models.slice(0, 200),
			}
		},
	}

	if (options.supportsEmbeddings !== false) {
		client.embed = async (
			credential,
			request: EmbedRequest,
		): Promise<EmbedResult> => {
			const response = await fetch(`${base(credential)}/embeddings`, {
				method: "POST",
				headers: headers(credential),
				body: JSON.stringify({
					model: request.model,
					input: request.input,
					...(options.supportsEmbeddingDimensions === false
						? {}
						: { dimensions: request.dimensions }),
				}),
			})
			if (!response.ok) throw await readError(id, response)

			const body = (await response.json()) as {
				data?: { embedding?: number[]; index?: number }[]
				usage?: { prompt_tokens?: number; total_tokens?: number }
			}

			// Providers are not required to return the inputs in order, and one
			// that does not would silently attach every vector to the wrong chunk.
			const vectors: number[][] = new Array(request.input.length)
			for (const [position, entry] of (body.data ?? []).entries()) {
				const index = entry.index ?? position
				if (entry.embedding) vectors[index] = entry.embedding
			}
			if (vectors.some((vector) => !vector)) {
				throw new ProviderError(id, "The embeddings response was missing vectors.")
			}

			return {
				vectors,
				embeddingTokens: body.usage?.prompt_tokens ?? body.usage?.total_tokens ?? 0,
			}
		}
	}

	return client
}

export const openaiClient = createOpenAiCompatible("openai", "https://api.openai.com/v1")
