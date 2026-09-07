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

interface Part {
	text?: string
	functionCall?: { name?: string; args?: Record<string, unknown> }
}

interface GenerateResponse {
	candidates?: {
		content?: { parts?: Part[] }
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

/**
 * Gemini has no `tool` role either: a result is a `functionResponse` part on a
 * **user** turn, and it correlates by function *name* rather than by a call id —
 * Gemini does not issue one. The adapter synthesises ids on the way out and
 * resolves them back to names here, so callers see the same shape as everywhere
 * else.
 */
function toContents(messages: ChatMessage[]) {
	const system = messages
		.filter((message) => message.role === "system")
		.map((message) => message.content)
		.join("\n\n")

	const contents: { role: string; parts: unknown[] }[] = []

	for (const message of messages) {
		if (message.role === "system") continue

		if (message.role === "tool") {
			const part = {
				functionResponse: {
					name: message.name ?? "",
					// Gemini requires an object here, so a tool that returns a string
					// is wrapped rather than sent bare.
					response: { result: message.content },
				},
			}
			const previous = contents.at(-1)
			if (previous?.role === "user") previous.parts.push(part)
			else contents.push({ role: "user", parts: [part] })
			continue
		}

		if (message.role === "assistant" && message.toolCalls?.length) {
			const parts: unknown[] = []
			if (message.content) parts.push({ text: message.content })
			for (const call of message.toolCalls) {
				parts.push({
					functionCall: { name: call.name, args: parseArguments(call.arguments) },
				})
			}
			contents.push({ role: "model", parts })
			continue
		}

		if (message.role === "user" && message.images?.length) {
			// An uncaptioned image is the ordinary case, so an empty text part is
			// omitted rather than sent blank — the same shape the assistant branch
			// above uses.
			const parts: unknown[] = []
			if (message.content) parts.push({ text: message.content })
			for (const image of message.images) {
				parts.push({
					inlineData: { mimeType: image.mediaType, data: image.dataBase64 },
				})
			}
			contents.push({ role: "user", parts })
			continue
		}

		contents.push({
			role: message.role === "assistant" ? "model" : "user",
			parts: [{ text: message.content }],
		})
	}

	return {
		systemInstruction: system ? { parts: [{ text: system }] } : undefined,
		contents,
	}
}

function parseArguments(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw) as unknown
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

/**
 * Gemini accepts a *subset* of JSON Schema and rejects the request outright when
 * it meets a keyword it does not know — `$schema` and `additionalProperties`
 * above all, both of which `z.toJSONSchema` emits as a matter of course. Rather
 * than hand-writing a second schema per tool, the one schema is trimmed here.
 */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
	"$schema",
	"additionalProperties",
	"$id",
	"$ref",
	"definitions",
	"$defs",
	"exclusiveMinimum",
	"exclusiveMaximum",
])

function trimSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(trimSchema)
	if (!value || typeof value !== "object") return value

	const output: Record<string, unknown> = {}
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue
		output[key] = trimSchema(entry)
	}
	return output
}

function toWireTools(tools: ToolDefinition[] | undefined) {
	if (!tools?.length) return undefined
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: trimSchema(tool.parameters),
			})),
		},
	]
}

/**
 * Gemini issues no call id, so one is made from the position of the call in the
 * turn. It only has to be unique within the exchange and stable enough for the
 * result to be matched back, and the result is matched by name anyway.
 */
function callsOf(parts: Part[]): ToolCall[] {
	return parts
		.filter((part) => part.functionCall?.name)
		.map((part, index) => ({
			id: `call_${index}`,
			name: part.functionCall?.name ?? "",
			arguments: JSON.stringify(part.functionCall?.args ?? {}),
		}))
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
	supportsTools: true,
	supportsVision: true,

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
					tools: toWireTools(request.tools),
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
			toolCalls: callsOf(body.candidates?.[0]?.content?.parts ?? []),
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
					tools: toWireTools(request.tools),
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
		let seen = 0

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

			// Unlike the other two, Gemini sends a `functionCall` part complete in
			// one chunk, so there is nothing to assemble — it is forwarded as it
			// arrives. `seen` only keeps the synthesised ids unique across chunks.
			for (const call of callsOf(candidate?.content?.parts ?? [])) {
				yield {
					type: "tool_call",
					call: { ...call, id: `call_${seen++}` },
				}
			}
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
