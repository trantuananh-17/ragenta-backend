import { findCatalogueModel, requireCredential } from "../../ai/catalogue"
import { chatCapableClient } from "../../ai/clients"
import type {
	ChatCapableClient,
	ChatMessage,
	TokenUsage,
	ToolCall,
} from "../../ai/clients"
import { estimateTokens } from "../../ai/tokens"
import type { MessageCitation } from "../../db/schema"
import { EntitlementError, NotFoundError, ValidationError, isAppError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import { billingService } from "../billing/billing.service"
import { assemblePrompt } from "../chat/prompt"
import type { Grounding } from "../chat/prompt"
import { knowledgeService } from "../knowledge/knowledge.service"
import { modelService } from "../model/model.service"
import { retrievalService } from "../retrieval/retrieval.service"
import type { RetrievalOutcome, RetrievedChunk, SearchMode } from "../retrieval/retrieval.service"
import { usageService } from "../usage/usage.service"
import { agentRepository } from "./agent.repository"
import type { AgentRow, AgentRunRow, AgentVersionRow } from "./agent.repository"
import type { RunAgentInput } from "./agent.dto"
import { CitationCollector } from "./citations"
import { toDefinition, toolsFor } from "./tools"
import type { AgentTool } from "./tools"
import { clearStop, isStopRequested } from "./stop-signal"

const log = logger.child({ module: "agent.runner" })

/** The ceiling on what one round can produce, when the version sets none. */
const DEFAULT_MAX_OUTPUT_TOKENS = 2_000

/** For a model with no context window recorded. Small enough to be safe anywhere. */
const FALLBACK_CONTEXT_WINDOW = 32_000

/**
 * Refuse a run below this balance rather than mid-stream, for the same reason a
 * chat turn does: a stream that dies halfway through is worse than a refusal,
 * and the exact cost is not knowable until the provider reports its counts.
 */
const MINIMUM_CREDITS = 5_000

/** How often a generating run asks whether it has been told to stop. */
const STOP_POLL_MS = 300

/**
 * The ceiling on rounds, whatever a version asks for. A version is validated
 * against this too; it is repeated here because the loop is the thing that can
 * actually run away.
 */
const MAX_ROUNDS_LIMIT = 10

/** How much of a tool's output is kept on the step row for the timeline. */
const STEP_OUTPUT_LIMIT = 2_000

export interface PreparedRun {
	agent: AgentRow
	version: AgentVersionRow
	run: AgentRunRow
	/** Narrowed at `prepare`: a provider with no chat adapter is refused there. */
	client: ChatCapableClient
	selection: { provider: string; model: string }
	input: RunAgentInput
	actorId: string | null
}

export type AgentStreamEvent =
	/** Sent before any token, so the client can ask for this run to stop. */
	| { type: "start"; runId: string }
	| { type: "phase"; phase: "retrieving" | "generating" }
	| { type: "citations"; citations: MessageCitation[] }
	/** A knowledge base this version names has been deleted and was skipped. */
	| { type: "warning"; message: string }
	/** Which round of the tool loop is running. Absent for an agent with no tools. */
	| { type: "round"; round: number; of: number }
	| { type: "tool_started"; seq: number; name: string; arguments: string }
	| { type: "tool_finished"; seq: number; name: string; ok: boolean; summary: string }
	| { type: "delta"; text: string }
	| {
			type: "done"
			runId: string
			status: "succeeded" | "failed" | "stopped"
			credits: number
			usage: { input: number; output: number }
		}
	| { type: "error"; message: string }

/** One model call's outcome, before it has been charged. */
interface Round {
	text: string
	toolCalls: ToolCall[]
	usage: TokenUsage
	/** What was sent, for the estimate a stopped round has to fall back on. */
	promptText: string
}

export const agentRunner = {
	/**
	 * Everything that can *refuse* a run, before a stream is opened — so a refusal
	 * is a status code the client can act on, not an error frame arriving after
	 * the UI has already switched into "running".
	 *
	 * The run row is written first and marked failed if a check refuses, the way a
	 * chat turn leaves its refusal in the thread: a toast is gone the moment it is
	 * dismissed, and the run list is where someone looks to find out what happened.
	 */
	async prepare(
		workspaceId: string,
		agentId: string,
		input: RunAgentInput,
		actorId: string | null,
	): Promise<PreparedRun> {
		const agent = await agentRepository.findById(workspaceId, agentId)
		if (!agent) throw new NotFoundError("Agent")

		const version = await agentRepository.findVersion(agent.id, agent.currentVersion)
		if (!version) throw new NotFoundError("Agent version")

		const run = await agentRepository.insertRun({
			id: newId(),
			organizationId: workspaceId,
			agentId: agent.id,
			agentVersionId: version.id,
			projectId: agent.projectId,
			userId: actorId,
			trigger: "manual",
			status: "running",
			input: { input: input.input, documentIds: input.documentIds ?? [] },
		})
		if (!run) throw new ValidationError("The run could not be started.")

		try {
			if (agent.status !== "active") {
				throw new ValidationError(
					`This agent is ${agent.status}. Activate it before running it.`,
				)
			}

			const summary = await billingService.getSummary(workspaceId)
			if (summary.credits.total < MINIMUM_CREDITS) {
				throw new EntitlementError(
					"INSUFFICIENT_CREDITS",
					"This workspace does not have enough credits to run an agent.",
					{ required: MINIMUM_CREDITS, available: summary.credits.total },
				)
			}

			const selection =
				version.provider && version.model
					? { provider: version.provider, model: version.model }
					: await modelService.resolveChatModel(
							workspaceId,
							agent.projectId ?? undefined,
						)
			// A version's stored override is re-checked rather than trusted: a
			// workspace that downgraded still has a premium model saved on it, and
			// that must fail loudly instead of quietly billing for it.
			if (version.provider && version.model) {
				await modelService.assertSelectable(workspaceId, selection, "chat")
			}

			const client = chatCapableClient(selection.provider)
			if (!client?.streamChat) {
				throw new ValidationError(
					`This deployment cannot run chat with the ${selection.provider} provider.`,
				)
			}
			// Publishing already refuses this combination. Checked again because a
			// version can name no model at all and inherit one that changed since.
			if (version.tools.length > 0 && !client.supportsTools) {
				throw new ValidationError(
					`The ${selection.provider} provider cannot call tools, and this agent is configured with ${version.tools.length} of them.`,
				)
			}

			return { agent, version, run, client, selection, input, actorId }
		} catch (error) {
			await agentRepository.updateRun(run.id, {
				status: "failed",
				error: (isAppError(error)
					? error.message
					: "Something went wrong before the run could start."
				).slice(0, 500),
				finishedAt: new Date(),
			})
			throw error
		}
	},

	/**
	 * Runs the agent, yielding events as they happen.
	 *
	 * Two shapes, one loop. An agent with no tools does exactly what a chat turn
	 * does: retrieve once, answer once. An agent with tools retrieves nothing up
	 * front and is given its tools instead, then runs model → tools → model until
	 * it stops asking for tools, `max_rounds` is reached, or the run has spent its
	 * credit ceiling.
	 *
	 * Billing is one `usage_ledger` row per provider call — every round, and every
	 * tool that made a provider call of its own — keyed on
	 * `agent-run:{runId}:step:{seq}`. That reference carries a unique index, so a
	 * step charged twice is refused by the database rather than by this code
	 * remembering not to (ADR-029).
	 */
	async *stream(
		workspaceId: string,
		prepared: PreparedRun,
		signal?: AbortSignal,
	): AsyncGenerator<AgentStreamEvent> {
		const { run, version, selection } = prepared

		// First, before a token exists: the client needs this id to ask for the run
		// to stop, and early enough that pressing stop half a second in works.
		yield { type: "start", runId: run.id }

		const credential = await requireCredential(selection.provider)
		const citations = new CitationCollector()
		const tools = toolsFor(version.tools, version.knowledgeBaseIds, citations)
		const maxRounds = Math.min(Math.max(version.maxRounds, 1), MAX_ROUNDS_LIMIT)
		const ceiling = version.creditCeiling === null ? null : Number(version.creditCeiling)

		let messages: ChatMessage[] = []
		let answer = ""
		let credits = 0
		let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
		let failure: string | undefined
		let stopped = false
		let seq = 0
		let finished = false
		/** Set while a round is in flight, so a stopped run still charges for it. */
		let inFlight: { promptText: string; text: string; usage: TokenUsage } | null = null

		const chargeStep = async (input: {
			kind: "model" | "retrieval" | "tool"
			name?: string
			provider: string
			model: string
			operation: "agent" | "rerank" | "embedding"
			inputTokens: number
			outputTokens: number
			estimated: boolean
			payload?: Record<string, unknown>
			output?: Record<string, unknown>
		}) => {
			const reference = `agent-run:${run.id}:step:${seq}`
			const charge = await usageService.recordAndCharge({
				workspaceId,
				projectId: prepared.agent.projectId,
				userId: prepared.actorId,
				operation: input.operation,
				provider: input.provider,
				model: input.model,
				inputTokens: input.inputTokens,
				outputTokens: input.outputTokens,
				reference,
				metadata: {
					agentId: prepared.agent.id,
					agentVersion: version.version,
					runId: run.id,
					step: input.kind,
					tokensEstimated: input.estimated,
				},
			})
			credits += charge.credits

			await agentRepository.insertStep({
				id: newId(),
				runId: run.id,
				seq,
				kind: input.kind,
				name: input.name ?? null,
				status: "succeeded",
				provider: input.provider,
				model: input.model,
				inputTokens: input.inputTokens,
				outputTokens: input.outputTokens,
				credits: charge.credits.toFixed(4),
				usageReference: reference,
				input: input.payload ?? {},
				output: input.output ?? {},
				finishedAt: new Date(),
			})
			seq += 1
		}

		/** A step that made no provider call — a tool that only read or fetched. */
		const recordFreeStep = async (input: {
			name: string
			ok: boolean
			payload: Record<string, unknown>
			output: Record<string, unknown>
		}) => {
			await agentRepository.insertStep({
				id: newId(),
				runId: run.id,
				seq,
				kind: "tool",
				name: input.name,
				status: input.ok ? "succeeded" : "failed",
				input: input.payload,
				output: input.output,
				finishedAt: new Date(),
			})
			seq += 1
		}

		/**
		 * Closes the run once, whatever ended it.
		 *
		 * In a `finally` rather than after the loop because a generator suspended
		 * at a `yield` is closed with `.return()` when its consumer stops iterating
		 * — a dropped connection, a closed tab — and a `return` completion is not an
		 * exception, so nothing after the loop would run. The output already
		 * streamed to the user would then exist nowhere (ADR-028).
		 */
		const persist = async () => {
			if (finished) return
			finished = true

			// A round cut off mid-stream never received the provider's usage frame,
			// but the provider generated those tokens and charged Ragenta for them.
			// Passing on nothing would make "stop" a way to read answers for free.
			if (inFlight && (inFlight.text.length > 0 || inFlight.usage.inputTokens > 0)) {
				const estimated =
					inFlight.usage.inputTokens === 0 && inFlight.usage.outputTokens === 0
				await chargeStep({
					kind: "model",
					provider: selection.provider,
					model: selection.model,
					operation: "agent",
					inputTokens: estimated
						? estimateTokens(inFlight.promptText)
						: inFlight.usage.inputTokens,
					outputTokens: estimated
						? estimateTokens(inFlight.text)
						: inFlight.usage.outputTokens,
					estimated,
					output: { characters: inFlight.text.length, stopped: true },
				}).catch((error: unknown) => {
					// Billing must not be the reason a saved answer is lost.
					log.error("agent.charge_failed", error, { runId: run.id })
				})
				inFlight = null
			}

			await agentRepository.updateRun(run.id, {
				status:
					answer.length === 0 && !stopped ? "failed" : stopped ? "stopped" : "succeeded",
				output: answer.length > 0 ? answer : null,
				error: failure ? failure.slice(0, 500) : null,
				credits: credits.toFixed(4),
				finishedAt: new Date(),
			})
		}

		try {
			yield { type: "phase", phase: "retrieving" }

			// An agent that searches for itself pre-retrieves nothing: the first
			// thing it does is choose what to search for, which is the whole point
			// of giving it the tool.
			const searchesItself = version.tools.includes("knowledge_search")
			const context = searchesItself
				? { messages: [] as ChatMessage[], missing: [] as string[], rerank: null }
				: await this.gatherContext(workspaceId, prepared, citations)

			if (context.missing.length > 0) {
				yield {
					type: "warning",
					message: `${context.missing.length} knowledge base(s) this agent was configured with no longer exist and were skipped.`,
				}
			}

			if (context.rerank && context.rerank.tokens > 0) {
				await chargeStep({
					kind: "retrieval",
					provider: context.rerank.provider,
					model: context.rerank.model,
					operation: "rerank",
					inputTokens: context.rerank.tokens,
					outputTokens: 0,
					estimated: context.rerank.estimated,
					output: { citations: citations.size },
				})
			}

			messages = searchesItself
				? this.openingMessages(prepared, version.instructions)
				: context.messages

			if (citations.size > 0) yield { type: "citations", citations: citations.all() }

			if (await isStopRequested(workspaceId, run.id)) {
				stopped = true
				return
			}

			yield { type: "phase", phase: "generating" }

			for (let round = 1; round <= maxRounds; round += 1) {
				if (tools.length > 0) yield { type: "round", round, of: maxRounds }

				const promptText = messages.map((message) => message.content).join("\n")
				inFlight = { promptText, text: "", usage: { inputTokens: 0, outputTokens: 0 } }

				const outcome: Round = {
					text: "",
					toolCalls: [],
					usage: { inputTokens: 0, outputTokens: 0 },
					promptText,
				}

				let nextStopCheck = Date.now() + STOP_POLL_MS

				for await (const event of prepared.client.streamChat(credential, {
					model: selection.model,
					messages,
					temperature:
						version.temperature === null ? undefined : Number(version.temperature),
					maxTokens: version.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
					tools: tools.length > 0 ? tools.map(toDefinition) : undefined,
					signal,
				})) {
					if (event.type === "delta") {
						outcome.text += event.text
						answer += event.text
						inFlight.text = outcome.text
						yield { type: "delta", text: event.text }
					} else if (event.type === "tool_call") {
						outcome.toolCalls.push(event.call)
					} else {
						outcome.usage = event.usage
						inFlight.usage = event.usage
					}

					// Checked between tokens rather than per token: a Redis round trip
					// on every delta would cost more than the generation it watches.
					if (Date.now() >= nextStopCheck) {
						nextStopCheck = Date.now() + STOP_POLL_MS
						if (await isStopRequested(workspaceId, run.id)) {
							stopped = true
							break
						}
					}
				}

				inFlight = null
				usage = {
					inputTokens: usage.inputTokens + outcome.usage.inputTokens,
					outputTokens: usage.outputTokens + outcome.usage.outputTokens,
				}

				const estimated =
					outcome.usage.inputTokens === 0 && outcome.usage.outputTokens === 0
				await chargeStep({
					kind: "model",
					provider: selection.provider,
					model: selection.model,
					operation: "agent",
					inputTokens: estimated
						? estimateTokens(promptText)
						: outcome.usage.inputTokens,
					outputTokens: estimated ? estimateTokens(outcome.text) : outcome.usage.outputTokens,
					estimated,
					output: {
						characters: outcome.text.length,
						toolCalls: outcome.toolCalls.map((call) => call.name),
					},
				})

				if (stopped || outcome.toolCalls.length === 0) break

				// The round asked for tools, so the model's own turn has to go into
				// the history before their results do, or the provider rejects a
				// result answering a call it cannot see.
				messages = [
					...messages,
					{ role: "assistant", content: outcome.text, toolCalls: outcome.toolCalls },
				]

				for (const call of outcome.toolCalls) {
					yield {
						type: "tool_started",
						seq,
						name: call.name,
						arguments: call.arguments.slice(0, 500),
					}

					const result = await this.runTool(tools, call, {
						workspaceId,
						projectId: prepared.agent.projectId,
						userId: prepared.actorId,
						runId: run.id,
						stepSeq: seq,
						signal,
					})

					if (result.usage) {
						await chargeStep({
							kind: "tool",
							name: call.name,
							provider: result.usage.provider,
							model: result.usage.model,
							operation: result.usage.operation,
							inputTokens: result.usage.inputTokens,
							outputTokens: result.usage.outputTokens,
							estimated: false,
							payload: { arguments: call.arguments.slice(0, STEP_OUTPUT_LIMIT) },
							output: result.metadata ?? {},
						})
					} else {
						await recordFreeStep({
							name: call.name,
							ok: result.ok,
							payload: { arguments: call.arguments.slice(0, STEP_OUTPUT_LIMIT) },
							output: {
								...(result.metadata ?? {}),
								preview: result.content.slice(0, STEP_OUTPUT_LIMIT),
							},
						})
					}

					yield {
						type: "tool_finished",
						seq: seq - 1,
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

				if (citations.size > 0) yield { type: "citations", citations: citations.all() }

				// Between rounds, not only before the run: a loop that started
				// affordable can stop being so, and the balance is the one limit that
				// is not this workspace's to set.
				if (ceiling !== null && credits >= ceiling) {
					failure = `This run reached its ceiling of ${ceiling} credits and was stopped.`
					break
				}
				const summary = await billingService.getSummary(workspaceId)
				if (summary.credits.total < MINIMUM_CREDITS) {
					failure = "This workspace ran out of credits part-way through the run."
					break
				}
				if (await isStopRequested(workspaceId, run.id)) {
					stopped = true
					break
				}
			}
		} catch (error) {
			failure = error instanceof Error ? error.message : "The run failed."
			log.error("agent.run_failed", error, { workspaceId, runId: run.id })
		} finally {
			await persist()
			await clearStop(workspaceId, run.id)
		}

		if (answer.length === 0 && failure) {
			yield { type: "error", message: failure }
			return
		}

		yield {
			type: "done",
			runId: run.id,
			status: stopped ? "stopped" : failure ? "failed" : "succeeded",
			credits,
			usage: { input: usage.inputTokens, output: usage.outputTokens },
		}
	},

	/**
	 * Executes one call the model asked for.
	 *
	 * Both failure modes answer the *model* rather than throwing: a tool it
	 * invented and arguments that do not validate are things it can correct on the
	 * next round, and ending the run would throw away everything already done.
	 */
	async runTool(
		tools: AgentTool[],
		call: ToolCall,
		context: {
			workspaceId: string
			projectId: string | null
			userId: string | null
			runId: string
			stepSeq: number
			signal?: AbortSignal
		},
	) {
		const tool = tools.find((candidate) => candidate.name === call.name)
		if (!tool) {
			return {
				ok: false,
				content: `There is no tool called "${call.name}". The tools you have are the ones listed for you.`,
				metadata: { error: "unknown_tool" },
				usage: undefined,
			}
		}

		let args: unknown
		try {
			args = JSON.parse(call.arguments || "{}")
		} catch {
			return {
				ok: false,
				content: "Those arguments were not valid JSON. Send the arguments again as a JSON object.",
				metadata: { error: "invalid_json" },
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
				metadata: { error: "tool_failed" },
				usage: undefined,
			}
		}
	},

	/** The opening exchange for an agent that will search for itself. */
	openingMessages(prepared: PreparedRun, instructions: string): ChatMessage[] {
		const { messages } = assemblePrompt(prepared.input.input, [], [], {
			contextWindow: FALLBACK_CONTEXT_WINDOW,
			maxOutputTokens: prepared.version.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
			grounding: "tools",
			instructions,
		})
		return messages
	},

	/**
	 * Searches the knowledge bases and builds the prompt, for an agent that does
	 * not have the search tool.
	 *
	 * A base the version names that has since been deleted is skipped and
	 * reported. The version is an immutable record of what was configured, so it
	 * cannot be corrected, and failing the whole run over one removed base would
	 * make deleting a knowledge base silently break every agent that mentioned it.
	 */
	async gatherContext(
		workspaceId: string,
		prepared: PreparedRun,
		citations: CitationCollector,
	): Promise<{
		messages: ChatMessage[]
		missing: string[]
		rerank: RetrievalOutcome["rerankUsage"]
	}> {
		const { version, input } = prepared
		const definition = await findCatalogueModel(
			prepared.selection.provider,
			prepared.selection.model,
		)

		const missing: string[] = []
		const baseIds: string[] = []
		for (const baseId of version.knowledgeBaseIds) {
			const exists = await knowledgeService
				.getBase(workspaceId, baseId)
				.then(() => true)
				.catch(() => false)
			if (exists) baseIds.push(baseId)
			else missing.push(baseId)
		}

		let retrieved: RetrievedChunk[] = []
		let rerank: RetrievalOutcome["rerankUsage"] = null

		if (baseIds.length > 0) {
			await knowledgeService.assertBasesSearchableTogether(workspaceId, baseIds)
			const outcome = await retrievalService.retrieve({
				workspaceId,
				knowledgeBaseIds: baseIds,
				question: input.input,
				topK: version.topK ?? undefined,
				mode: version.searchMode as SearchMode,
				similarityThreshold:
					version.similarityThreshold === null
						? undefined
						: Number(version.similarityThreshold),
				vectorWeight:
					version.vectorWeight === null ? undefined : Number(version.vectorWeight),
				rerank:
					version.rerankProvider && version.rerankModel
						? { provider: version.rerankProvider, model: version.rerankModel }
						: undefined,
				documentIds: input.documentIds,
			})
			retrieved = outcome.chunks
			rerank = outcome.rerankUsage
		}

		const grounding: Grounding =
			baseIds.length === 0 ? "open" : version.groundedOnly ? "documents" : "documents-open"

		const { messages, used } = assemblePrompt(input.input, retrieved, [], {
			contextWindow: definition?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
			maxOutputTokens: version.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
			grounding,
			instructions: version.instructions,
		})

		citations.add(used)

		return { messages, missing, rerank }
	},
}
