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
} from "./types"
import { ProviderError, readError, sseLines } from "./types"

/**
 * The Gemini generative-language API.
 *
 * It departs from the other two in three ways worth stating: the role for the
 * model is `model`, not `assistant`; the system prompt is `systemInstruction`;
 * and the key goes in a header rather than a bearer token. Everything else is
 * the same request shaped differently.
 */
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

interface UsageMetadata {
	promptTokenCount?: number
	candidatesTokenCount?: number
	totalTokenCount?: number
}

interface GenerateResponse {
	candidates?: {
		content?: { parts?: { text?: string }[] }
		finishReason?: string
	}[]
	usageMetadata?: UsageMetadata
}

const base = (credential: ProviderCredential) =>
	(credential.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")

function headers(credential: ProviderCredential) {
	return {
		"content-type": "application/json",
		"x-goog-api-key": credential.apiKey,
	}
}

function toContents(messages: ChatMessage[]) {
	const system = messages
		.filter((message) => message.role === "system")
		.map((message) => message.content)
		.join("\n\n")

	return {
		systemInstruction: system ? { parts: [{ text: system }] } : undefined,
		contents: messages
			.filter((message) => message.role !== "system")
			.map((message) => ({
				role: message.role === "assistant" ? "model" : "user",
				parts: [{ text: message.content }],
			})),
	}
}

function textOf(response: GenerateResponse): string {
	return (response.candidates?.[0]?.content?.parts ?? [])
		.map((part) => part.text ?? "")
		.join("")
}

function usageOf(metadata: UsageMetadata | undefined): TokenUsage {
	return {
		inputTokens: metadata?.promptTokenCount ?? 0,
		outputTokens: metadata?.candidatesTokenCount ?? 0,
	}
}

export const googleClient: ProviderClient = {
	id: "google",
	defaultBaseUrl: DEFAULT_BASE_URL,

	async chat(credential, request: ChatRequest): Promise<ChatResult> {
		const { systemInstruction, contents } = toContents(request.messages)

		const response = await fetch(
			`${base(credential)}/models/${encodeURIComponent(request.model)}:generateContent`,
			{
				method: "POST",
				headers: headers(credential),
				signal: request.signal,
				body: JSON.stringify({
					contents,
					systemInstruction,
					generationConfig: {
						temperature: request.temperature,
						maxOutputTokens: request.maxTokens,
					},
				}),
			},
		)
		if (!response.ok) throw await readError("google", response)

		const body = (await response.json()) as GenerateResponse
		return {
			text: textOf(body),
			usage: usageOf(body.usageMetadata),
			finishReason: body.candidates?.[0]?.finishReason ?? "STOP",
		}
	},

	async *streamChat(credential, request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
		const { systemInstruction, contents } = toContents(request.messages)

		// `alt=sse` is required: without it the endpoint answers with a single
		// JSON array that only completes when the whole generation does, which
		// looks like a stream and behaves like a blocking call.
		const response = await fetch(
			`${base(credential)}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
			{
				method: "POST",
				headers: headers(credential),
				signal: request.signal,
				body: JSON.stringify({
					contents,
					systemInstruction,
					generationConfig: {
						temperature: request.temperature,
						maxOutputTokens: request.maxTokens,
					},
				}),
			},
		)
		if (!response.ok) throw await readError("google", response)

		let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
		let finishReason = "STOP"

		for await (const payload of sseLines(response)) {
			let chunk: GenerateResponse
			try {
				chunk = JSON.parse(payload) as GenerateResponse
			} catch {
				continue
			}

			// Every chunk restates the running totals, so the last one seen is the
			// final count — there is nothing to accumulate.
			if (chunk.usageMetadata) usage = usageOf(chunk.usageMetadata)
			const candidate = chunk.candidates?.[0]
			if (candidate?.finishReason) finishReason = candidate.finishReason

			const text = textOf(chunk)
			if (text) yield { type: "delta", text }
		}

		yield { type: "done", usage, finishReason }
	},

	/**
	 * `batchEmbedContents` rather than one call per input: a document of 400
	 * chunks would otherwise be 400 round trips, and the per-request latency
	 * dominates the whole ingestion.
	 */
	async embed(credential, request: EmbedRequest): Promise<EmbedResult> {
		const model = request.model.startsWith("models/")
			? request.model
			: `models/${request.model}`

		const response = await fetch(
			`${base(credential)}/${model}:batchEmbedContents`,
			{
				method: "POST",
				headers: headers(credential),
				body: JSON.stringify({
					requests: request.input.map((text) => ({
						model,
						content: { parts: [{ text }] },
						outputDimensionality: request.dimensions,
					})),
				}),
			},
		)
		if (!response.ok) throw await readError("google", response)

		const body = (await response.json()) as {
			embeddings?: { values?: number[] }[]
		}
		const vectors = (body.embeddings ?? []).map((entry) => entry.values ?? [])
		if (vectors.length !== request.input.length || vectors.some((v) => v.length === 0)) {
			throw new ProviderError("google", "The embeddings response was missing vectors.")
		}

		// Gemini's embedding endpoint reports no token count. Usage is still
		// recorded, from the characters sent, and the ~4 chars/token ratio is
		// stated where it is applied rather than hidden behind a zero here.
		return { vectors, embeddingTokens: 0 }
	},

	async check(credential): Promise<CheckResult> {
		const response = await fetch(`${base(credential)}/models`, {
			headers: headers(credential),
		})
		if (!response.ok) throw await readError("google", response)

		const body = (await response.json()) as { models?: { name?: string }[] }
		const models = (body.models ?? [])
			.map((entry) => entry.name?.replace(/^models\//, ""))
			.filter((value): value is string => Boolean(value))

		return {
			ok: true,
			detail: `Key accepted. ${models.length} model${models.length === 1 ? "" : "s"} visible.`,
			models: models.slice(0, 200),
		}
	},
}
