import { findCatalogueModel, requireCredential } from "../../ai/catalogue"
import { chatCapableClient } from "../../ai/clients"
import type { ChatCapableClient, ChatMessage, ProviderCredential } from "../../ai/clients"
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
import { agentGraphSchema } from "./graph/types"
import type { GraphState } from "./graph/engine"
import { runGraph } from "./graph/engine"
import type { NodeContext } from "./graph/nodes"
import { runApprovedTool, runToolLoop } from "./loop"
import { toolWrites, toolsFor } from "./tools"
import { clearStop, isStopRequested } from "./stop-signal"

const log = logger.child({ module: "agent.runner" })

/** The ceiling on what one model call can produce, when the version sets none. */
const DEFAULT_MAX_OUTPUT_TOKENS = 2_000

/** For a model with no context window recorded. Small enough to be safe anywhere. */
const FALLBACK_CONTEXT_WINDOW = 32_000

/**
 * Refuse a run below this balance rather than mid-stream, for the same reason a
 * chat turn does: a stream that dies halfway through is worse than a refusal,
 * and the exact cost is not knowable until the provider reports its counts.
 */
const MINIMUM_CREDITS = 5_000

/** The ceiling on rounds, whatever a version asks for. */
const MAX_ROUNDS_LIMIT = 10

/** One provider call to price, record and bill. `nodeId` is set inside a flow. */
interface ChargeInput {
	kind: "model" | "retrieval" | "tool"
	nodeId?: string
	name?: string
	provider: string
	model: string
	operation: "agent" | "rerank" | "embedding"
	inputTokens: number
	outputTokens: number
	estimated: boolean
	payload?: Record<string, unknown>
	output?: Record<string, unknown>
}

export interface PreparedRun {
	agent: AgentRow
	version: AgentVersionRow
	run: AgentRunRow
	/** Narrowed at `prepare`: a provider with no chat adapter is refused there. */
	client: ChatCapableClient
	selection: { provider: string; model: string }
	input: RunAgentInput
	actorId: string | null
	/** Set when resuming: the state the paused run left behind. */
	resume?: {
		state: GraphState & { loop?: LoopPause }
		answers: Record<string, string>
		/** Present when the pause was a write waiting to be approved (ADR-032). */
		approval?: { approved: boolean; call: PendingCall } | null
	} | null
}

/** A write the run stopped in front of, saved so it can happen after approval. */
export interface PendingCall {
	id: string
	name: string
	arguments: string
}

/** What a paused tool loop saved. Values only, like a paused flow's state. */
export interface LoopPause {
	messages: ChatMessage[]
	call: PendingCall
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
	/** Flow runs only: which node is executing. */
	| { type: "node_started"; nodeId: string; label: string; nodeType: string }
	| { type: "node_finished"; nodeId: string; label: string; ok: boolean }
	/** The flow is waiting for a person. The run is saved and the stream ends. */
	| {
			type: "awaiting_input"
			runId: string
			nodeId: string
			prompt: string
			fields: string[]
		}
	| { type: "delta"; text: string }
	| {
			type: "done"
			runId: string
			status: "succeeded" | "failed" | "stopped" | "awaiting_input"
			credits: number
			usage: { input: number; output: number }
		}
	| { type: "error"; message: string }

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
			return await this.check(workspaceId, agent, version, run, input, actorId)
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
	 * Resumes a flow that stopped at a `user_input` node.
	 *
	 * The same run row rather than a new one: it is one execution of one version
	 * that happened to wait for a person in the middle, and splitting it in two
	 * would make its credits and its steps belong to two different things.
	 */
	async resume(
		workspaceId: string,
		runId: string,
		answers: Record<string, string>,
		actorId: string | null,
	): Promise<PreparedRun> {
		const run = await agentRepository.findRun(workspaceId, runId)
		if (!run) throw new NotFoundError("Agent run")
		if (run.status !== "awaiting_input") {
			throw new ValidationError("This run is not waiting for an answer.")
		}

		const agent = await agentRepository.findById(workspaceId, run.agentId)
		if (!agent) throw new NotFoundError("Agent")

		// The version the run *started* on, not the agent's current one. A flow
		// half-executed against one graph cannot finish against another.
		const version = await agentRepository.findVersionById(run.agentVersionId)
		if (!version) throw new NotFoundError("Agent version")

		const state = run.state as unknown as GraphState & { loop?: LoopPause }
		const input = { input: String((run.input as { input?: string }).input ?? "") }

		await agentRepository.updateRun(run.id, { status: "running" })

		return {
			...(await this.check(workspaceId, agent, version, run, input, actorId)),
			resume: {
				state,
				answers,
				approval: state.loop
					? {
							// Anything other than an explicit yes is a no. A pause that
							// timed out, or an answer nobody understood, must not become
							// permission to send the email.
							approved: (answers.approve ?? "").trim().toLowerCase() === "yes",
							call: state.loop.call,
						}
					: null,
			},
		}
	},

	/** The refusals, shared by a fresh run and a resumed one. */
	async check(
		workspaceId: string,
		agent: AgentRow,
		version: AgentVersionRow,
		run: AgentRunRow,
		input: RunAgentInput,
		actorId: string | null,
	): Promise<PreparedRun> {
		if (agent.status !== "active") {
			throw new ValidationError(`This agent is ${agent.status}. Activate it before running it.`)
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
				: await modelService.resolveChatModel(workspaceId, agent.projectId ?? undefined)
		// A version's stored override is re-checked rather than trusted: a workspace
		// that downgraded still has a premium model saved on it, and that must fail
		// loudly instead of quietly billing for it.
		if (version.provider && version.model) {
			await modelService.assertSelectable(workspaceId, selection, "chat")
		}

		const client = chatCapableClient(selection.provider)
		if (!client?.streamChat) {
			throw new ValidationError(
				`This deployment cannot run chat with the ${selection.provider} provider.`,
			)
		}
		// Publishing already refuses this. Checked again because a version can name
		// no model at all and inherit one that changed since.
		if ((version.tools.length > 0 || version.graph) && !client.supportsTools) {
			throw new ValidationError(
				`The ${selection.provider} provider cannot call tools, which this agent needs.`,
			)
		}

		return { agent, version, run, client, selection, input, actorId }
	},

	/**
	 * Runs the agent, yielding events as they happen.
	 *
	 * Three shapes, one set of machinery. A version with a graph runs the flow
	 * engine; one with tools runs the loop; one with neither retrieves once and
	 * answers once, exactly as a chat turn does. What they share — charging a
	 * `usage_ledger` row per provider call keyed `agent-run:{runId}:step:{seq}`,
	 * the stop flag, and closing the run exactly once in a `finally` — lives here
	 * rather than three times (ADR-029, ADR-031).
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
		const ceiling = version.creditCeiling === null ? null : Number(version.creditCeiling)

		let answer = ""
		let credits = 0
		let usage = { inputTokens: 0, outputTokens: 0 }
		let failure: string | undefined
		let stopped = false
		let awaiting = false
		let seq = 0
		let finished = false
		let state: GraphState | null = null
		let loopPause: LoopPause | null = null

		const charge = async (input: ChargeInput) => {
			const reference = `agent-run:${run.id}:step:${seq}`
			const charged = await usageService.recordAndCharge({
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
					nodeId: input.nodeId ?? null,
					tokensEstimated: input.estimated,
				},
			})
			credits += charged.credits
			usage = {
				inputTokens: usage.inputTokens + input.inputTokens,
				outputTokens: usage.outputTokens + input.outputTokens,
			}

			await agentRepository.insertStep({
				id: newId(),
				runId: run.id,
				seq,
				kind: input.kind,
				name: input.name ?? null,
				nodeId: input.nodeId ?? null,
				status: "succeeded",
				provider: input.provider,
				model: input.model,
				inputTokens: input.inputTokens,
				outputTokens: input.outputTokens,
				credits: charged.credits.toFixed(4),
				usageReference: reference,
				input: input.payload ?? {},
				output: input.output ?? {},
				finishedAt: new Date(),
			})
			seq += 1
		}

		/** A step that made no provider call — a tool that only read or fetched. */
		const record = async (input: {
			nodeId?: string
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
				nodeId: input.nodeId ?? null,
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
		 * In a `finally` rather than after the loop because a generator suspended at
		 * a `yield` is closed with `.return()` when its consumer stops iterating — a
		 * dropped connection, a closed tab — and a `return` completion is not an
		 * exception, so nothing after the loop would run. The output already
		 * streamed to the user would then exist nowhere (ADR-028).
		 */
		const persist = async () => {
			if (finished) return
			finished = true

			await agentRepository.updateRun(run.id, {
				status: awaiting
					? "awaiting_input"
					: answer.length === 0 && !stopped
						? "failed"
						: stopped
							? "stopped"
							: "succeeded",
				output: answer.length > 0 ? answer : null,
				error: failure ? failure.slice(0, 500) : null,
				credits: credits.toFixed(4),
				...(state ? { state: state as unknown as Record<string, unknown> } : {}),
				...(loopPause
					? { state: { loop: loopPause } as unknown as Record<string, unknown> }
					: {}),
				// A run still waiting for a person has not finished.
				...(awaiting ? {} : { finishedAt: new Date() }),
			})
		}

		const stopCheck = () => isStopRequested(workspaceId, run.id)
		const mayContinue = async (): Promise<"ok" | "ceiling" | "no_credits"> => {
			if (ceiling !== null && credits >= ceiling) return "ceiling"
			const summary = await billingService.getSummary(workspaceId)
			return summary.credits.total < MINIMUM_CREDITS ? "no_credits" : "ok"
		}

		try {
			if (version.graph) {
				const graph = agentGraphSchema.parse(version.graph)

				const context: NodeContext = {
					workspaceId,
					projectId: prepared.agent.projectId,
					userId: prepared.actorId,
					runId: run.id,
					client: prepared.client,
					credential: credential as ProviderCredential,
					selection,
					maxOutputTokens: version.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
					temperature: version.temperature === null ? undefined : Number(version.temperature),
					knowledgeBaseIds: version.knowledgeBaseIds,
					citations,
					values: {},
					signal,
					charge,
					record,
				}

				// The answers to a `user_input` node arrive as that node's values, so
				// the node finds them already present and passes straight through.
				const resumed = prepared.resume
					? {
							...prepared.resume.state,
							values: {
								...prepared.resume.state.values,
								...(prepared.resume.state.pending
									? { [prepared.resume.state.pending]: prepared.resume.answers }
									: {}),
							},
						}
					: null

				yield { type: "phase", phase: "generating" }

				for await (const event of runGraph({
					graph,
					context,
					state: resumed,
					input: prepared.input.input,
					isStopped: stopCheck,
				})) {
					if (event.type === "delta") {
						answer += event.text
						yield { type: "delta", text: event.text }
					} else if (event.type === "citations") {
						yield { type: "citations", citations: citations.all() }
					} else if (event.type === "node_started") {
						yield event
					} else if (event.type === "node_finished") {
						yield event
					} else if (event.type === "tool_started") {
						yield { type: "tool_started", seq, name: event.name, arguments: event.arguments }
					} else if (event.type === "tool_finished") {
						yield {
							type: "tool_finished",
							seq: Math.max(seq - 1, 0),
							name: event.name,
							ok: event.ok,
							summary: event.summary,
						}
					} else if (event.type === "awaiting_input") {
						awaiting = true
						state = event.state
						answer = event.state.output
						yield {
							type: "awaiting_input",
							runId: run.id,
							nodeId: event.nodeId,
							prompt: event.prompt,
							fields: event.fields,
						}
					} else if (event.type === "finished") {
						state = event.state
						if (event.output) answer = event.output
					} else {
						state = event.state
						failure = event.message
					}
				}
			} else {
				yield* this.runSingle(workspaceId, prepared, {
					citations,
					charge,
					record,
					stopCheck,
					mayContinue,
					signal,
					onDelta: (text) => {
						answer += text
					},
					onStopped: () => {
						stopped = true
					},
					onFailure: (message) => {
						failure = message
					},
					onAwaiting: (pause) => {
						awaiting = true
						loopPause = pause
					},
					resume:
						prepared.resume?.approval && prepared.resume.state.loop
							? {
									approved: prepared.resume.approval.approved,
									call: prepared.resume.approval.call,
									messages: prepared.resume.state.loop.messages,
								}
							: null,
				})
			}

			if (await stopCheck()) stopped = true
		} catch (error) {
			failure = error instanceof Error ? error.message : "The run failed."
			log.error("agent.run_failed", error, { workspaceId, runId: run.id })
		} finally {
			await persist()
			if (!awaiting) await clearStop(workspaceId, run.id)
		}

		if (answer.length === 0 && failure) {
			yield { type: "error", message: failure }
			return
		}

		yield {
			type: "done",
			runId: run.id,
			status: awaiting
				? "awaiting_input"
				: stopped
					? "stopped"
					: failure
						? "failed"
						: "succeeded",
			credits,
			usage: { input: usage.inputTokens, output: usage.outputTokens },
		}
	},

	/**
	 * The non-graph path: retrieve (unless the agent searches for itself), then
	 * run the tool loop. With no tools and `maxRounds` of 1 that is exactly one
	 * model call, which is a Phase 1 agent.
	 */
	async *runSingle(
		workspaceId: string,
		prepared: PreparedRun,
		hooks: {
			citations: CitationCollector
			charge: (input: ChargeInput) => Promise<void>
			record: (input: { name: string; ok: boolean; payload: Record<string, unknown>; output: Record<string, unknown> }) => Promise<void>
			stopCheck: () => Promise<boolean>
			mayContinue: () => Promise<"ok" | "ceiling" | "no_credits">
			signal?: AbortSignal
			onDelta: (text: string) => void
			onStopped: () => void
			onFailure: (message: string) => void
			onAwaiting: (pause: LoopPause) => void
			/** The approval decision, when this call is resuming a paused run. */
			resume?: { approved: boolean; call: PendingCall; messages: ChatMessage[] } | null
		},
	): AsyncGenerator<AgentStreamEvent> {
		const { version, selection } = prepared
		const credential = await requireCredential(selection.provider)
		const searchesItself = version.tools.includes("knowledge_search")

		yield { type: "phase", phase: "retrieving" }

		const context = searchesItself
			? { messages: [] as ChatMessage[], missing: [] as string[], rerank: null }
			: await this.gatherContext(workspaceId, prepared, hooks.citations)

		if (context.missing.length > 0) {
			yield {
				type: "warning",
				message: `${context.missing.length} knowledge base(s) this agent was configured with no longer exist and were skipped.`,
			}
		}

		if (context.rerank && context.rerank.tokens > 0) {
			await hooks.charge({
				kind: "retrieval",
				provider: context.rerank.provider,
				model: context.rerank.model,
				operation: "rerank",
				inputTokens: context.rerank.tokens,
				outputTokens: 0,
				estimated: context.rerank.estimated,
				output: { citations: hooks.citations.size },
			})
		}

		let messages = searchesItself
			? this.openingMessages(prepared, version.instructions)
			: context.messages

		const tools = toolsFor(version.tools, version.knowledgeBaseIds, hooks.citations)

		/**
		 * Resuming an approved write: the call has to happen *before* the loop is
		 * re-entered, because the loop starts by asking the model — and the model
		 * cannot be asked anything until the tool call it made has an answer.
		 */
		if (hooks.resume) {
			const { approved, call } = hooks.resume
			messages = hooks.resume.messages

			const result = approved
				? await runApprovedTool(tools, call, {
						workspaceId,
						projectId: prepared.agent.projectId,
						userId: prepared.actorId,
						runId: prepared.run.id,
						stepSeq: 0,
						signal: hooks.signal,
					})
				: {
						ok: false,
						// Phrased as a decision rather than a failure, so the model
						// reports that a person declined instead of retrying it.
						content: `A person declined this ${call.name} call. Do not try it again; explain what you would have done and stop.`,
						metadata: { declined: true } as Record<string, unknown>,
						usage: undefined,
					}

			yield {
				type: "tool_started",
				seq: 0,
				name: call.name,
				arguments: call.arguments.slice(0, 500),
			}
			await hooks.record({
				name: call.name,
				ok: result.ok,
				payload: { arguments: call.arguments.slice(0, 2_000), approved },
				output: { ...(result.metadata ?? {}), preview: result.content.slice(0, 2_000) },
			})
			yield {
				type: "tool_finished",
				seq: 0,
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

		if (hooks.citations.size > 0) {
			yield { type: "citations", citations: hooks.citations.all() }
		}

		if (await hooks.stopCheck()) {
			hooks.onStopped()
			return
		}

		yield { type: "phase", phase: "generating" }

		let seqForTools = 0

		for await (const event of runToolLoop(messages, {
			client: prepared.client,
			credential,
			model: selection.model,
			temperature: version.temperature === null ? undefined : Number(version.temperature),
			maxTokens: version.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
			tools,
			maxRounds: Math.min(Math.max(version.maxRounds, 1), MAX_ROUNDS_LIMIT),
			toolContext: {
				workspaceId,
				projectId: prepared.agent.projectId,
				userId: prepared.actorId,
				runId: prepared.run.id,
				signal: hooks.signal,
			},
			isStopped: hooks.stopCheck,
			mayContinue: hooks.mayContinue,
			signal: hooks.signal,
			needsApproval: version.approveWrites
				? (name) => toolWrites(name)
				: undefined,
		})) {
			if (event.type === "delta") {
				hooks.onDelta(event.text)
				yield { type: "delta", text: event.text }
			} else if (event.type === "round") {
				yield { type: "round", round: event.round, of: event.of }
			} else if (event.type === "tool_started") {
				yield {
					type: "tool_started",
					seq: seqForTools,
					name: event.name,
					arguments: event.arguments,
				}
			} else if (event.type === "tool_finished") {
				yield {
					type: "tool_finished",
					seq: seqForTools++,
					name: event.name,
					ok: event.ok,
					summary: event.summary,
				}
				if (hooks.citations.size > 0) {
					yield { type: "citations", citations: hooks.citations.all() }
				}
			} else if (event.type === "round_finished") {
				await hooks.charge({
					kind: "model",
					provider: selection.provider,
					model: selection.model,
					operation: "agent",
					inputTokens: event.charge.inputTokens,
					outputTokens: event.charge.outputTokens,
					estimated: event.charge.estimated,
					output: {
						characters: event.charge.text.length,
						toolCalls: event.charge.toolNames,
					},
				})
			} else if (event.type === "tool_charge") {
				if (event.charge.usage) {
					await hooks.charge({
						kind: "tool",
						name: event.charge.name,
						provider: event.charge.usage.provider,
						model: event.charge.usage.model,
						operation: event.charge.usage.operation,
						inputTokens: event.charge.usage.inputTokens,
						outputTokens: event.charge.usage.outputTokens,
						estimated: false,
						payload: { arguments: event.charge.arguments },
						output: event.charge.metadata,
					})
				} else {
					await hooks.record({
						name: event.charge.name,
						ok: event.charge.ok,
						payload: { arguments: event.charge.arguments },
						output: { ...event.charge.metadata, preview: event.charge.content },
					})
				}
			} else if (event.type === "awaiting_approval") {
				hooks.onAwaiting({ messages: event.messages, call: event.call })
				yield {
					type: "awaiting_input",
					runId: prepared.run.id,
					nodeId: event.call.name,
					prompt: `This agent wants to run ${event.call.name}. Approve it?

${event.call.arguments.slice(0, 800)}`,
					fields: ["approve"],
				}
				return
			} else if (event.type === "finished") {
				if (event.reason === "stopped") hooks.onStopped()
				if (event.reason === "ceiling") {
					hooks.onFailure("This run reached its credit ceiling and was stopped.")
				}
				if (event.reason === "no_credits") {
					hooks.onFailure("This workspace ran out of credits part-way through the run.")
				}
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
