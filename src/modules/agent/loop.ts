import type { ChatCapableClient, ChatMessage, ProviderCredential, TokenUsage } from "../../ai/clients"
import { estimateTokens } from "../../ai/tokens"
import { isAppError } from "../../shared/errors"
import { logger } from "../../shared/logger"
import { toDefinition } from "./tools"
import type { AgentTool, ToolContext } from "./tools"

const log = logger.child({ module: "agent.loop" })

/** How much of a tool's arguments and output is worth keeping on a step row. */
const STEP_TEXT_LIMIT = 2_000

/**
 * One model call the loop has finished, for the caller to charge and record.
 *
 * The loop does not write to the database or touch billing itself: it is used
 * both by a run that streams to a browser and by a single node inside a graph,
 * and those two record their steps differently. What it does own is the part
 * that must not differ — how many rounds, when to stop, how a tool failure is
 * reported to the model.
 */
export interface RoundCharge {
	inputTokens: number
	outputTokens: number
	/** True when the provider reported nothing and the counts are guesses. */
	estimated: boolean
	text: string
	toolNames: string[]
}

export interface ToolCharge {
	name: string
	ok: boolean
	arguments: string
	content: string
	metadata: Record<string, unknown>
	usage?: {
		provider: string
		model: string
		inputTokens: number
		outputTokens: number
		operation: "embedding" | "rerank" | "agent"
	}
}

export type LoopEvent =
	| { type: "round"; round: number; of: number }
	| { type: "delta"; text: string }
	| { type: "tool_started"; name: string; arguments: string }
	| { type: "tool_finished"; name: string; ok: boolean; summary: string }
	/** A model call finished. The caller charges and records it. */
	| { type: "round_finished"; charge: RoundCharge }
	/** A tool call finished. The caller charges and records it. */
	| { type: "tool_charge"; charge: ToolCharge }
	/** The loop ended. `reason` says why, for the run's own record. */
	| {
			type: "finished"
			text: string
			usage: TokenUsage
			reason: "answered" | "max_rounds" | "stopped" | "ceiling" | "no_credits"
		}

export interface LoopOptions {
	client: ChatCapableClient
	credential: ProviderCredential
	model: string
	temperature?: number
	maxTokens: number
	tools: AgentTool[]
	maxRounds: number
	toolContext: Omit<ToolContext, "stepSeq">
	/** Whether the run has been asked to stop. Polled between rounds and tokens. */
	isStopped?: () => Promise<boolean>
	/** Whether the run may keep going: false ends the loop with `reason`. */
	mayContinue?: () => Promise<"ok" | "ceiling" | "no_credits">
	/** Emitted token by token. False for a node inside a graph, whose output is a value. */
	streamDeltas?: boolean
	signal?: AbortSignal
}

/** How often the loop asks whether it has been told to stop, while generating. */
const STOP_POLL_MS = 300

/**
 * model → tools → model, until the model stops asking for tools.
 *
 * The bound is deliberately three things rather than one: rounds, the caller's
 * own limit (a credit ceiling), and a stop request. Rounds alone would let an
 * expensive model spend without limit inside a small number of them, and a
 * ceiling alone would let a cheap one loop pointlessly.
 */
export async function* runToolLoop(
	initial: ChatMessage[],
	options: LoopOptions,
): AsyncGenerator<LoopEvent> {
	let messages = [...initial]
	let answer = ""
	const total: TokenUsage = { inputTokens: 0, outputTokens: 0 }
	const definitions = options.tools.length > 0 ? options.tools.map(toDefinition) : undefined
	let stepSeq = 0

	for (let round = 1; round <= options.maxRounds; round += 1) {
		if (definitions) yield { type: "round", round, of: options.maxRounds }

		const promptText = messages.map((message) => message.content).join("\n")
		let text = ""
		let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
		const calls: { id: string; name: string; arguments: string }[] = []
		let stopped = false
		let nextStopCheck = Date.now() + STOP_POLL_MS

		for await (const event of options.client.streamChat(options.credential, {
			model: options.model,
			messages,
			temperature: options.temperature,
			maxTokens: options.maxTokens,
			tools: definitions,
			signal: options.signal,
		})) {
			if (event.type === "delta") {
				text += event.text
				if (options.streamDeltas !== false) yield { type: "delta", text: event.text }
			} else if (event.type === "tool_call") {
				calls.push(event.call)
			} else {
				usage = event.usage
			}

			// Between tokens rather than per token: a Redis round trip on every
			// delta would cost more than the generation it is watching.
			if (options.isStopped && Date.now() >= nextStopCheck) {
				nextStopCheck = Date.now() + STOP_POLL_MS
				if (await options.isStopped()) {
					stopped = true
					break
				}
			}
		}

		answer = text || answer
		total.inputTokens += usage.inputTokens
		total.outputTokens += usage.outputTokens

		// A round cut off never received the provider's usage frame, but the
		// provider generated those tokens and charged for them. Passing on nothing
		// would make "stop" a way to read answers for free.
		const estimated = usage.inputTokens === 0 && usage.outputTokens === 0
		yield {
			type: "round_finished",
			charge: {
				inputTokens: estimated ? estimateTokens(promptText) : usage.inputTokens,
				outputTokens: estimated ? estimateTokens(text) : usage.outputTokens,
				estimated,
				text,
				toolNames: calls.map((call) => call.name),
			},
		}

		if (stopped) {
			yield { type: "finished", text: answer, usage: total, reason: "stopped" }
			return
		}
		if (calls.length === 0) {
			yield { type: "finished", text: answer, usage: total, reason: "answered" }
			return
		}

		// The model's own turn has to go into the history before the results do,
		// or the provider rejects a result answering a call it cannot see.
		messages = [...messages, { role: "assistant", content: text, toolCalls: calls }]

		for (const call of calls) {
			yield {
				type: "tool_started",
				name: call.name,
				arguments: call.arguments.slice(0, 500),
			}

			const result = await executeTool(options.tools, call, {
				...options.toolContext,
				stepSeq: stepSeq++,
			})

			yield {
				type: "tool_charge",
				charge: {
					name: call.name,
					ok: result.ok,
					arguments: call.arguments.slice(0, STEP_TEXT_LIMIT),
					content: result.content.slice(0, STEP_TEXT_LIMIT),
					metadata: result.metadata ?? {},
					usage: result.usage,
				},
			}
			yield {
				type: "tool_finished",
				name: call.name,
				ok: result.ok,
				summary: result.content.slice(0, 200),
			}

			messages = [
				...messages,
				{
					role: "tool",
					content: result.content,
					toolCallId: call.id,
					name: call.name,
				},
			]
		}

		if (options.mayContinue) {
			const verdict = await options.mayContinue()
			if (verdict !== "ok") {
				yield { type: "finished", text: answer, usage: total, reason: verdict }
				return
			}
		}
		if (options.isStopped && (await options.isStopped())) {
			yield { type: "finished", text: answer, usage: total, reason: "stopped" }
			return
		}
	}

	yield { type: "finished", text: answer, usage: total, reason: "max_rounds" }
}

/**
 * Runs one call the model asked for.
 *
 * Every failure answers the *model* rather than throwing: a tool it invented and
 * arguments that do not validate are things it can correct on the next round,
 * and ending the run would discard every round already paid for.
 */
async function executeTool(
	tools: AgentTool[],
	call: { name: string; arguments: string },
	context: ToolContext,
) {
	const tool = tools.find((candidate) => candidate.name === call.name)
	if (!tool) {
		return {
			ok: false,
			content: `There is no tool called "${call.name}". The tools you have are the ones listed for you.`,
			metadata: { error: "unknown_tool" } as Record<string, unknown>,
			usage: undefined,
		}
	}

	let args: unknown
	try {
		args = JSON.parse(call.arguments || "{}")
	} catch {
		return {
			ok: false,
			content: "Those arguments were not valid JSON. Send them again as a JSON object.",
			metadata: { error: "invalid_json" } as Record<string, unknown>,
			usage: undefined,
		}
	}

	try {
		return await tool.execute(context, args)
	} catch (error) {
		log.error("agent.tool_failed", error, { runId: context.runId, tool: call.name })
		return {
			ok: false,
			content: isAppError(error)
				? error.message
				: `The ${call.name} tool failed. Try a different approach.`,
			metadata: { error: "tool_failed" } as Record<string, unknown>,
			usage: undefined,
		}
	}
}
