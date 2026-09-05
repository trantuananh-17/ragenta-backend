import type {
	ChatMessage,
	ChatRequest,
	ChatResult,
	ChatStreamEvent,
	CheckResult,
	ProviderClient,
	ProviderCredential,
	TokenUsage,
} from "./types"
import { readError, sseLines } from "./types"

/**
 * The Anthropic Messages API.
 *
 * Two things differ from the OpenAI shape and both are handled here rather than
 * leaked to callers: the system prompt is a top-level field instead of a
 * message, and `max_tokens` is required. Anthropic sells no embedding model, so
 * this client has no `embed` — a knowledge base indexed with Anthropic selected
 * is refused when the model is resolved, not when the request is made.
 */
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
const API_VERSION = "2023-06-01"

/**
 * Anthropic rejects a request with no `max_tokens`. A conservative ceiling is
 * better than none: a runaway generation is billed to the workspace that asked
 * for it, and nobody asked for 200k tokens of output.
 */
const DEFAULT_MAX_TOKENS = 4096

interface MessagesResponse {
	content?: { type?: string; text?: string }[]
	stop_reason?: string
	usage?: { input_tokens?: number; output_tokens?: number }
}

function split(messages: ChatMessage[]) {
	const system = messages
		.filter((message) => message.role === "system")
		.map((message) => message.content)
		.join("\n\n")

	return {
		system: system || undefined,
		messages: messages
			.filter((message) => message.role !== "system")
			.map((message) => ({ role: message.role, content: message.content })),
	}
}

function headers(credential: ProviderCredential) {
	return {
		"content-type": "application/json",
		"x-api-key": credential.apiKey,
		"anthropic-version": API_VERSION,
	}
}

const base = (credential: ProviderCredential) =>
	(credential.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")

export const anthropicClient: ProviderClient = {
	id: "anthropic",
	defaultBaseUrl: DEFAULT_BASE_URL,

	async chat(credential, request: ChatRequest): Promise<ChatResult> {
		const { system, messages } = split(request.messages)

		const response = await fetch(`${base(credential)}/messages`, {
			method: "POST",
			headers: headers(credential),
			signal: request.signal,
			body: JSON.stringify({
				model: request.model,
				system,
				messages,
				temperature: request.temperature,
				max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
			}),
		})
		if (!response.ok) throw await readError("anthropic", response)

		const body = (await response.json()) as MessagesResponse
		return {
			text: (body.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join(""),
			usage: {
				inputTokens: body.usage?.input_tokens ?? 0,
				outputTokens: body.usage?.output_tokens ?? 0,
			},
			finishReason: body.stop_reason ?? "end_turn",
		}
	},

	async *streamChat(credential, request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
		const { system, messages } = split(request.messages)

		const response = await fetch(`${base(credential)}/messages`, {
			method: "POST",
			headers: headers(credential),
			signal: request.signal,
			body: JSON.stringify({
				model: request.model,
				system,
				messages,
				temperature: request.temperature,
				max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
				stream: true,
			}),
		})
		if (!response.ok) throw await readError("anthropic", response)

		// Input tokens arrive once on message_start and output tokens accumulate
		// on message_delta, so the two halves of the bill come from two events.
		const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
		let finishReason = "end_turn"

		for await (const payload of sseLines(response)) {
			let event: Record<string, unknown>
			try {
				event = JSON.parse(payload) as Record<string, unknown>
			} catch {
				continue
			}

			switch (event.type) {
				case "message_start": {
					const message = event.message as MessagesResponse | undefined
					usage.inputTokens = message?.usage?.input_tokens ?? 0
					usage.outputTokens = message?.usage?.output_tokens ?? 0
					break
				}
				case "content_block_delta": {
					const delta = event.delta as { type?: string; text?: string } | undefined
					if (delta?.type === "text_delta" && delta.text) {
						yield { type: "delta", text: delta.text }
					}
					break
				}
				case "message_delta": {
					const delta = event.delta as { stop_reason?: string } | undefined
					const partial = event.usage as { output_tokens?: number } | undefined
					if (delta?.stop_reason) finishReason = delta.stop_reason
					if (partial?.output_tokens !== undefined) {
						usage.outputTokens = partial.output_tokens
					}
					break
				}
				case "error": {
					const error = event.error as { message?: string } | undefined
					throw new Error(error?.message ?? "Anthropic reported an error mid-stream.")
				}
			}
		}

		yield { type: "done", usage, finishReason }
	},

	/**
	 * The model list, which is authenticated and free — a generation would also
	 * prove the key works but would bill the deployment every time somebody
	 * pressed the button on the models screen.
	 */
	async check(credential): Promise<CheckResult> {
		const response = await fetch(`${base(credential)}/models`, {
			headers: headers(credential),
		})
		if (!response.ok) throw await readError("anthropic", response)

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
