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
import { attachmentService } from "../attachment/attachment.service"
import type { MessageAttachmentRow } from "../attachment/attachment.repository"
import { getObject } from "../../storage/objects"
import { knowledgeService } from "../knowledge/knowledge.service"
import { modelService } from "../model/model.service"
import { retrievalService } from "../retrieval/retrieval.service"
import type { RetrievalOutcome, RetrievedChunk, SearchMode } from "../retrieval/retrieval.service"
import { usageService } from "../usage/usage.service"
import { agentRepository } from "./agent.repository"
import type { AgentRow, AgentRunRow, AgentVersionRow } from "./agent.repository"
import type { RunAgentInput } from "./agent.dto"
import {
	PICKUP_STATUSES,
	RUN_TIMEOUT_MS,
	buildCheckpoint,
	chargeReference,
	nextSeq,
	readCheckpoint,
} from "./checkpoint"
import type { GraphState, LoopPause, PendingCall, RunCheckpoint } from "./checkpoint"
import { CitationCollector } from "./citations"
import { agentGraphSchema } from "./graph/types"
import { runGraph } from "./graph/engine"
import type { NodeContext } from "./graph/nodes"
import { runApprovedTool, runToolLoop } from "./loop"
import { memoryService } from "../memory/memory.service"
import { webhookService } from "../webhook/webhook.service"
import { databaseToolFor, mcpToolsFor, toolWrites, toolsFor } from "./tools"
import { renderMemories } from "./tools/memory-content"
import { clearStop, isStopRequested } from "./stop-signal"

const log = logger.child({ module: "agent.runner" })

/** What the run was asked to do, read back off its own row rather than a caller. */
function runInput(run: AgentRunRow): RunAgentInput {
	const stored = run.input as {
		input?: unknown
		documentIds?: unknown
		attachmentIds?: unknown
	}
	return {
		input: typeof stored.input === "string" ? stored.input : "",
		documentIds: stringList(stored.documentIds),
		attachmentIds: stringList(stored.attachmentIds),
	}
}

/**
 * A list of ids off a stored JSON column, or nothing.
 *
 * The row is the only record of what a run was asked to do — a retry days later
 * reads it back rather than the request that started it — so a value that is not
 * a list of strings is dropped rather than coerced.
 */
function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined
	const ids = value.filter((id): id is string => typeof id === "string")
	return ids.length > 0 ? ids : undefined
}

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
	/**
	 * Where a previous attempt of this run got to, or null for a fresh one.
	 *
	 * One field for two things that are the same thing to the runner: a run a
	 * person paused and answered, and a run whose process died. Both carry on
	 * from the last node boundary, with the step numbering the first attempt
	 * left off at — which is what keeps the replayed work from being billed
	 * again (see `checkpoint.ts`).
	 */
	checkpoint: RunCheckpoint | null
	/** The answers a paused run was waiting for. Empty when nobody was asked. */
	answers: Record<string, string>
	/**
	 * The images this run carries, resolved and checked at `check` rather than
	 * where they are used. A flow reads their ids through `{{sys.attachments}}`;
	 * a single-prompt agent sends their bytes to the model. Resolving once means
	 * an id belonging to another workspace fails before the run starts, not
	 * half-way through a node that has already been billed.
	 */
	attachments: MessageAttachmentRow[]
	actorId: string | null
}

export type { LoopPause, PendingCall }

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
		/**
		 * Set when an embedded widget caused this run.
		 *
		 * It is what ties the run's spend to a widget's daily ceiling, and it is
		 * recorded rather than inferred: a run started by a stranger on somebody
		 * else's website should be distinguishable in the run list from one a
		 * colleague started (ADR-065).
		 */
		source?: { trigger: "widget"; widgetId: string },
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
			trigger: source?.trigger ?? "manual",
			widgetId: source?.widgetId ?? null,
			// `running` is claimed by the attempt itself, in `stream`, so a run
			// that never gets that far is visibly waiting rather than apparently
			// executing in a process that has not touched it.
			status: "pending",
			input: {
				input: input.input,
				documentIds: input.documentIds ?? [],
				attachmentIds: input.attachmentIds ?? [],
			},
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

		return {
			...(await this.check(workspaceId, agent, version, run, runInput(run), actorId)),
			checkpoint: readCheckpoint(run.state),
			answers,
		}
	},

	/**
	 * Picks a run up in the worker (ADR-029's `QUEUE_AGENT`): one that has been
	 * queued and never started, or one whose previous attempt died mid-flight.
	 *
	 * Returns null rather than throwing when there is nothing to do, because a
	 * BullMQ job runs more than once and the second run of it must be a no-op.
	 * A run that has finished, been stopped, or is waiting on a person is not
	 * something a retry may restart — resuming a pause is a person's decision
	 * and has its own route.
	 */
	async pickUp(workspaceId: string, runId: string): Promise<PreparedRun | null> {
		const run = await agentRepository.findRun(workspaceId, runId)
		if (!run) throw new NotFoundError("Agent run")
		if (!(PICKUP_STATUSES as readonly string[]).includes(run.status)) return null

		const agent = await agentRepository.findById(workspaceId, run.agentId)
		if (!agent) throw new NotFoundError("Agent")

		// The version the run started on, not the agent's current one.
		const version = await agentRepository.findVersionById(run.agentVersionId)
		if (!version) throw new NotFoundError("Agent version")

		try {
			return {
				...(await this.check(workspaceId, agent, version, run, runInput(run), run.userId)),
				checkpoint: readCheckpoint(run.state),
				answers: {},
			}
		} catch (error) {
			// Same as `prepare`: a refusal belongs in the run row, because nobody
			// is watching a queued run and a thrown job is not an explanation.
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

		const attachments = await this.resolveAttachments(workspaceId, input, !version.graph)

		/*
			Refused here only for a single-prompt run, which sends the image to the
			model itself. A flow reaches a picture through its `vision` or `ocr`
			node, and those refuse at the step rather than before the run — so a
			flow that also does useful work without the picture still does it, and
			the refusal names the step that could not proceed.

			**Its node uses the agent's own model, not the workspace's.** That is a
			deliberate trade and it costs something: an agent on a cheap text model
			with one image step used to borrow whatever the workspace was set to,
			and now refuses instead. The alternative was worse — a step silently
			running on a model nobody chose for it is exactly the defect this
			replaced, and a fallback would have hidden the case that actually
			happens, which is a vision model recorded in the catalogue as blind. A
			per-node model override is the real answer and is not built.

			Both halves are checked, as chat checks them: the model has to be able
			to read an image, and this deployment's adapter has to actually send
			one. Either missing means the agent answers about a picture it never
			received, fluently and billably, with nothing in the reply to say so.
		*/
		if (attachments.length > 0 && !version.graph) {
			const definition = await findCatalogueModel(selection.provider, selection.model)
			if (!definition?.vision || !client.supportsVision) {
				throw new ValidationError(
					`${selection.model} cannot read images. Choose a model that can, or run this agent without attachments.`,
				)
			}
		}

		return {
			agent,
			version,
			run,
			client,
			selection,
			input,
			actorId,
			checkpoint: null,
			answers: {},
			attachments,
		}
	},

	/**
	 * The files a run claims, checked before anything is charged.
	 *
	 * `findOrFail` is the workspace boundary: an id from another workspace is a
	 * 404 here rather than somebody else's file reaching a prompt.
	 *
	 * **What may be attached depends on what will read it.** A single-prompt run
	 * hands its files straight to the model, and the only thing a chat model
	 * takes as bytes is a picture — so anything else there is refused, in the
	 * words of the file rather than of the type system. A flow reads a file
	 * through a node instead: `excel` opens a workbook, `ocr` and `vision` open
	 * an image, `stt` opens a recording. Restricting a flow to images would rule
	 * out the spreadsheet case the `excel` node exists for.
	 */
	async resolveAttachments(
		workspaceId: string,
		input: RunAgentInput,
		imagesOnly: boolean,
	): Promise<MessageAttachmentRow[]> {
		const ids = [...new Set(input.attachmentIds ?? [])]
		if (ids.length === 0) return []

		const rows = await Promise.all(
			ids.map((id) => attachmentService.findOrFail(workspaceId, id)),
		)

		for (const row of rows) {
			if (imagesOnly && row.kind !== "image") {
				throw new ValidationError(
					`"${row.fileName}" is not an image. This agent sends what it is given straight to the model, which can only read pictures — a flow can open other files with a step.`,
				)
			}
			if (row.status !== "ready") {
				throw new ValidationError(`"${row.fileName}" has not finished uploading.`)
			}
		}

		return rows
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
	 *
	 * **Every counter it keeps is seeded from the checkpoint, not from zero.**
	 * The step number decides the usage reference, so restarting it at zero would
	 * bill replayed work again under a name the unique index cannot recognise;
	 * the credit total decides the ceiling, so restarting that would hand a
	 * resumed run a fresh budget every time it paused.
	 */
	async *stream(
		workspaceId: string,
		prepared: PreparedRun,
		signal?: AbortSignal,
	): AsyncGenerator<AgentStreamEvent> {
		const { run, version, selection, checkpoint } = prepared

		// First, before a token exists: the client needs this id to ask for the run
		// to stop, and early enough that pressing stop half a second in works.
		yield { type: "start", runId: run.id }

		// Claims the run for this attempt. `attempts` is what says a run has been
		// picked up more than once, which is otherwise invisible.
		await agentRepository.startAttempt(run.id)

		const credential = await requireCredential(selection.provider)
		const citations = new CitationCollector()
		const ceiling = version.creditCeiling === null ? null : Number(version.creditCeiling)
		const deadline = Date.now() + RUN_TIMEOUT_MS

		// Seeded only when this attempt *continues* what was already streamed — a
		// resumed flow, or a tool loop carrying on past an approval. A retry of a
		// failed loop re-asks the model from the beginning, and prefixing its
		// answer with the dead attempt's text would show the same paragraph twice.
		let answer = checkpoint && (checkpoint.graph || checkpoint.loop) ? checkpoint.output : ""
		let credits = checkpoint?.credits ?? 0
		let usage = checkpoint?.usage ?? { inputTokens: 0, outputTokens: 0 }
		let failure: string | undefined
		let stopped = false
		let awaiting = false
		let timedOut = false
		let exhausted = false
		let seq = nextSeq(checkpoint)
		let finished = false
		let state: GraphState | null = checkpoint?.graph ?? null
		let loopPause: LoopPause | null = null

		const charge = async (input: ChargeInput) => {
			const reference = chargeReference(run.id, seq)
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
			// `alreadyApplied` is the database refusing a second charge on a
			// reference it has seen — this call is work a dead attempt already paid
			// for. Adding its credits again would not bill anyone twice, but it
			// would push the run past its ceiling on money nobody spent.
			if (!charged.alreadyApplied) {
				credits += charged.credits
				usage = {
					inputTokens: usage.inputTokens + input.inputTokens,
					outputTokens: usage.outputTokens + input.outputTokens,
				}
			}
			if (ceiling !== null && credits >= ceiling) exhausted = true

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
				// A tool that fails answers with a sentence — "Gmail API is not enabled
				// for this project" — and it lands in `output`. Left out of `error`,
				// the timeline read "this step failed and recorded no reason" while the
				// reason sat one toggle below it, which sent people looking for a bug
				// in the wrong place. Anything reading steps gets it now, not only this
				// screen.
				error: input.ok ? null : reasonFrom(input.output),
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
		const snapshot = () =>
			buildCheckpoint({
				graph: state,
				loop: loopPause,
				seq,
				credits,
				usage,
				output: answer,
			}) as unknown as Record<string, unknown>

		/**
		 * Writes the checkpoint at a boundary the run can be picked up from.
		 *
		 * Only at boundaries — after a node, after a tool-loop round — never after
		 * an individual charge. `seq` in the checkpoint is where a replay *starts*
		 * numbering, so advancing it mid-node would give the interrupted node's
		 * calls fresh references on the next attempt, and the ledger would have no
		 * way to see they had already been paid for.
		 */
		const checkpointRun = async () => {
			await agentRepository.updateRun(run.id, {
				state: snapshot(),
				credits: credits.toFixed(4),
			})
		}

		const persist = async () => {
			if (finished) return
			finished = true

			const status = awaiting
				? "awaiting_input"
				: stopped
					? "stopped"
					: failure || answer.length === 0
						? "failed"
						: "succeeded"

			await agentRepository.updateRun(run.id, {
				status,
				output: answer.length > 0 ? answer : null,
				error: failure ? failure.slice(0, 500) : null,
				credits: credits.toFixed(4),
				// Written whatever the outcome, not only on a pause: a failed or
				// stopped run is the case a retry has to carry on from.
				state: snapshot(),
				// A run still waiting for a person has not finished.
				...(awaiting ? {} : { finishedAt: new Date() }),
			})

			// After the row is written, never before: a webhook that arrives ahead
			// of the state it describes sends the receiver to an API that still
			// says the run is going. `emit` never throws, so a subscriber's
			// problem cannot become this run's (ADR-067).
			//
			// Only the two terminal outcomes. A stopped run was somebody pressing
			// stop and a paused one has not finished, so neither is news.
			if (status === "succeeded" || status === "failed") {
				await webhookService.emit(workspaceId, `agent.run.${status}`, {
					runId: run.id,
					agentId: prepared.agent.id,
					agentName: prepared.agent.name,
					trigger: run.trigger,
					credits: Number(credits.toFixed(4)),
					durationMs: Date.now() - run.startedAt.getTime(),
					...(status === "failed" ? { error: failure ?? "The run produced no answer." } : {}),
				})
			}
		}

		/**
		 * The three ways a run stops between steps, as one check, because the
		 * engine and the tool loop both take exactly one.
		 *
		 * Each of them stops the run at the next boundary and keeps what it has —
		 * never mid-node, which would discard a provider call already paid for
		 * (ADR-028).
		 */
		const stopCheck = async (): Promise<boolean> => {
			if (exhausted) return true
			if (Date.now() > deadline) {
				timedOut = true
				return true
			}
			return isStopRequested(workspaceId, run.id)
		}

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
				const resumed = checkpoint?.graph
					? {
							...checkpoint.graph,
							values: {
								...checkpoint.graph.values,
								...(checkpoint.graph.pending
									? { [checkpoint.graph.pending]: prepared.answers }
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
					attachmentIds: prepared.attachments.map((row) => row.id),
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
					} else if (event.type === "checkpoint") {
						state = event.state
						await checkpointRun()
					} else if (event.type === "stopped") {
						state = event.state
						answer = event.state.output
						stopped = true
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
					onCheckpoint: checkpointRun,
					resume: checkpoint?.loop
						? {
								// Anything other than an explicit yes is a no. A pause
								// that timed out, or an answer nobody understood, must
								// not become permission to send the email.
								approved: (prepared.answers.approve ?? "").trim().toLowerCase() === "yes",
								call: checkpoint.loop.call,
								messages: checkpoint.loop.messages,
							}
						: null,
				})
			}

			// Which of the three bounds ended the run. All of them stop it at the
			// same place — the next boundary, with the checkpoint kept — so what is
			// being decided here is only what to call it, and a person asking for
			// the run to stop outranks the machine's limits: they meant it, and a
			// stop is not a failure. A timeout and a spent ceiling are, with a
			// reason and a checkpoint to retry from.
			if (await isStopRequested(workspaceId, run.id)) {
				stopped = true
			} else if (timedOut) {
				stopped = false
				failure ??= `This run passed its ${Math.round(RUN_TIMEOUT_MS / 60_000)}-minute limit and was stopped at its last checkpoint. Retry it to carry on.`
			} else if (exhausted) {
				stopped = false
				failure ??= "This run reached its credit ceiling and was stopped."
			}
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
			/** Called at each round boundary — the tool loop's resumable point. */
			onCheckpoint: () => Promise<void>
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
			? await this.openingMessages(prepared, version.instructions)
			: context.messages

		const tools = toolsFor(
			version.tools,
			version.knowledgeBaseIds,
			hooks.citations,
			version.memoryEnabled
				? {
						agentId: prepared.agent.id,
						scope: version.memoryScope === "user" ? "user" : "agent",
						topK: version.memoryTopK,
					}
				: undefined,
		)
		// Third-party tools are resolved after the built-ins because doing so may
		// call the servers; a run with none pays nothing.
		tools.push(...(await mcpToolsFor(workspaceId, version.tools, hooks.signal)))
		tools.push(...(await databaseToolFor(workspaceId, version.tools)))

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
						model: selection,
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
				model: selection,
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
				// A round is where this path can be picked up from. The conversation
				// itself is not saved — only a pause for approval saves that (ADR-032)
				// — so a retry re-asks the model, and the preserved step numbering is
				// what stops the replay being charged for a second time.
				await hooks.onCheckpoint()
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

	/**
	 * Puts the run's images on the message the model reads as the question.
	 *
	 * The bytes travel inline rather than as a link, for the reason `ImagePart`
	 * records: object storage binds to localhost on the VM, so a URL Ragenta can
	 * sign is a URL no provider can fetch.
	 *
	 * A picture that cannot be read fails the run. This is the opposite of what
	 * chat does with an *old* image, and deliberately: chat can drop one because
	 * the thread continues and the question is the new text, whereas an agent run
	 * carrying an image is a run **about** that image, and answering without it
	 * would be answering a different question at full price.
	 */
	async attachImages(
		messages: ChatMessage[],
		attachments: MessageAttachmentRow[],
	): Promise<ChatMessage[]> {
		if (attachments.length === 0) return messages

		const images = await Promise.all(
			attachments.map(async (row) => ({
				mediaType: row.mimeType,
				dataBase64: (await getObject(row.storageKey)).toString("base64"),
			})),
		)

		// The last user message, not the first: `assemblePrompt` puts retrieved
		// passages in earlier turns, and the images belong to the question.
		const question = [...messages].reverse().find((message) => message.role === "user")
		if (question) question.images = images

		return messages
	},

	/** The opening exchange for an agent that will search for itself. */
	async openingMessages(
		prepared: PreparedRun,
		instructions: string,
	): Promise<ChatMessage[]> {
		const { messages } = assemblePrompt(prepared.input.input, [], [], {
			contextWindow: FALLBACK_CONTEXT_WINDOW,
			maxOutputTokens: prepared.version.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
			grounding: "tools",
			instructions,
			memories: await this.recallMemories(prepared),
		})
		return this.attachImages(messages, prepared.attachments)
	},

	/**
	 * What this agent remembers that bears on the run's own input, fetched once
	 * before the first model call.
	 *
	 * Recall happens here rather than being left to `memory_search` because a
	 * model only calls a tool it thinks of: an agent that has been told something
	 * important should not have to guess that it was told. The tool remains, for
	 * the older or more specific thing this pass would not surface.
	 *
	 * Returns an empty string on any failure — memory is an enhancement, and a run
	 * that cannot recall should answer without it rather than not answer.
	 */
	async recallMemories(prepared: PreparedRun): Promise<string> {
		const { version } = prepared
		if (!version.memoryEnabled) return ""

		const memories = await memoryService.recall(
			{
				workspaceId: prepared.agent.organizationId,
				agentId: prepared.agent.id,
				userId: version.memoryScope === "user" ? prepared.actorId : null,
			},
			prepared.input.input,
			version.memoryTopK,
		)

		return renderMemories(memories)
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
			// Both paths recall, or an agent would remember only when it happened to
			// have been given the search tool.
			memories: await this.recallMemories(prepared),
		})

		citations.add(used)

		return {
			messages: await this.attachImages(messages, prepared.attachments),
			missing,
			rerank,
		}
	},
}

/**
 * The sentence a failed tool left behind.
 *
 * Tools report a failure as ordinary content rather than by throwing — the model
 * is meant to read it and try something else — so the reason is a field in the
 * output rather than an exception. `preview` is what the renderers write and
 * `content` is what a raw tool returns; neither is guaranteed, and a step with
 * genuinely nothing to say keeps its null.
 */
function reasonFrom(output: Record<string, unknown>): string | null {
	for (const key of ["preview", "content", "error", "message"]) {
		const value = output[key]
		if (typeof value === "string" && value.trim()) return value.trim().slice(0, 2_000)
	}
	return null
}
