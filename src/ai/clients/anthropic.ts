import type {
	ChatMessage,
	ChatRequest,
	ChatResult,
	ChatStreamEvent,
	CheckResult,
	ProviderClient,
	ProviderCredential,
	TokenUsage,
	ToolDefinition,
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
	content?: {
		type?: string
		text?: string
		id?: string
		name?: string
		input?: unknown
	}[]
	stop_reason?: string
	usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * Anthropic has no `tool` role: a tool's output is a `tool_result` block inside
 * a **user** message, and consecutive results have to be merged into one message
 * or the API rejects two user turns in a row. That merging is the only reason
 * this is not a straight `map`.
 */
function split(messages: ChatMessage[]) {
	const system = messages
		.filter((message) => message.role === "system")
		.map((message) => message.content)
		.join("\n\n")

	const wire: { role: "user" | "assistant"; content: unknown }[] = []

	for (const message of messages) {
		if (message.role === "system") continue

		if (message.role === "tool") {
			const block = {
				type: "tool_result" as const,
				tool_use_id: message.toolCallId,
				content: message.content,
			}
			const previous = wire.at(-1)
			if (previous?.role === "user" && Array.isArray(previous.content)) {
				previous.content.push(block)
			} else {
				wire.push({ role: "user", content: [block] })
			}
			continue
		}

		if (message.role === "assistant" && message.toolCalls?.length) {
			const blocks: unknown[] = []
			if (message.content) blocks.push({ type: "text", text: message.content })
			for (const call of message.toolCalls) {
				blocks.push({
					type: "tool_use",
					id: call.id,
					name: call.name,
					// The API wants a parsed object. A model that produced arguments
					// which do not parse still has to be echoed something back, or the
					// conversation cannot continue at all — an empty object is the
					// least wrong choice, and the tool result beside it says what went
					// wrong.
					input: parseArguments(call.arguments),
				})
			}
			wire.push({ role: "assistant", content: blocks })
			continue
		}

		wire.push({ role: message.role, content: message.content })
	}

	return { system: system || undefined, messages: wire }
}

function parseArguments(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw) as unknown
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

function toWireTools(tools: ToolDefinition[] | undefined) {
	if (!tools?.length) return undefined
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	}))
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
	supportsTools: true,

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
				tools: toWireTools(request.tools),
			}),
		})
		if (!response.ok) throw await readError("anthropic", response)

		const body = (await response.json()) as MessagesResponse
		return {
			text: (body.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join(""),
			toolCalls: (body.content ?? [])
				.filter((block) => block.type === "tool_use" && block.name)
				.map((block) => ({
					id: block.id ?? "",
					name: block.name ?? "",
					arguments: JSON.stringify(block.input ?? {}),
				})),
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
				tools: toWireTools(request.tools),
				stream: true,
			}),
		})
		if (!response.ok) throw await readError("anthropic", response)

		// Input tokens arrive once on message_start and output tokens accumulate
		// on message_delta, so the two halves of the bill come from two events.
		const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
		let finishReason = "end_turn"
		// A tool call is opened by `content_block_start`, filled by a run of
		// `input_json_delta` fragments and closed by `content_block_stop`, all
		// keyed by block index. It is emitted whole at the close.
		const openCalls = new Map<number, { id: string; name: string; json: string }>()

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
				case "content_block_start": {
					const block = event.content_block as
						| { type?: string; id?: string; name?: string }
						| undefined
					if (block?.type === "tool_use" && block.name) {
						openCalls.set(Number(event.index ?? 0), {
							id: block.id ?? "",
							name: block.name,
							json: "",
						})
					}
					break
				}
				case "content_block_delta": {
					const delta = event.delta as
						| { type?: string; text?: string; partial_json?: string }
						| undefined
					if (delta?.type === "text_delta" && delta.text) {
						yield { type: "delta", text: delta.text }
					}
					if (delta?.type === "input_json_delta") {
						const open = openCalls.get(Number(event.index ?? 0))
						if (open) open.json += delta.partial_json ?? ""
					}
					break
				}
				case "content_block_stop": {
					const index = Number(event.index ?? 0)
					const open = openCalls.get(index)
					if (open) {
						openCalls.delete(index)
						yield {
							type: "tool_call",
							call: {
								id: open.id || `call_${index}`,
								name: open.name,
								// A tool taking no arguments produces no fragments at all,
								// and "" is not JSON.
								arguments: open.json || "{}",
							},
						}
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
