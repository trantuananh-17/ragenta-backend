import type {
	ChatRequest,
	ChatResult,
	ChatStreamEvent,
	CheckResult,
	EmbedRequest,
	EmbedResult,
	ProviderClient,
	ProviderCredential,
	TokenUsage,
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
interface CompletionResponse {
	choices?: { message?: { content?: string }; finish_reason?: string }[]
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

interface StreamChunk {
	choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
	usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

function usageOf(raw: CompletionResponse["usage"] | StreamChunk["usage"]): TokenUsage {
	return {
		inputTokens: raw?.prompt_tokens ?? 0,
		outputTokens: raw?.completion_tokens ?? 0,
	}
}

export function createOpenAiCompatible(
	id: string,
	defaultBaseUrl: string,
	options: { supportsEmbeddings?: boolean } = {},
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

		async chat(credential, request: ChatRequest): Promise<ChatResult> {
			const response = await fetch(`${base(credential)}/chat/completions`, {
				method: "POST",
				headers: headers(credential),
				signal: request.signal,
				body: JSON.stringify({
					model: request.model,
					messages: request.messages,
					temperature: request.temperature,
					max_tokens: request.maxTokens,
				}),
			})
			if (!response.ok) throw await readError(id, response)

			const body = (await response.json()) as CompletionResponse
			const choice = body.choices?.[0]
			return {
				text: choice?.message?.content ?? "",
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
					messages: request.messages,
					temperature: request.temperature,
					max_tokens: request.maxTokens,
					stream: true,
					// Without this the final chunk carries no usage and the turn
					// cannot be billed from the provider's own count.
					stream_options: { include_usage: true },
				}),
			})
			if (!response.ok) throw await readError(id, response)

			let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
			let finishReason = "stop"

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
					dimensions: request.dimensions,
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
