import { findCatalogueModel, requireCredential } from "../../ai/catalogue"
import { chatCapableClient } from "../../ai/clients"
import type { ChatCapableClient, ChatMessage, TokenUsage } from "../../ai/clients"
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
import { clearStop, isStopRequested } from "./stop-signal"

const log = logger.child({ module: "agent.runner" })

/** The ceiling on what one run can produce, when the version sets none. */
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
 * Everything one run needs, resolved before generation starts. Named rather than
 * inferred from `prepare`, because a function referring to its own return type
 * would make the whole object's type circular.
 */
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

/** Retrieval and prompt assembly, which happen after the stream has opened. */
interface RunContext {
	messages: ChatMessage[]
	citations: MessageCitation[]
	rerankUsage: RetrievalOutcome["rerankUsage"]
	/** Bases the version names that no longer exist. Reported, never fatal. */
	missingBaseIds: string[]
}

export type AgentStreamEvent =
	/** Sent before any token, so the client can ask for this run to stop. */
	| { type: "start"; runId: string }
	| { type: "phase"; phase: "retrieving" | "generating" }
	| { type: "citations"; citations: MessageCitation[] }
	/** Knowledge bases this version names that have since been deleted. */
	| { type: "warning"; message: string }
	| { type: "delta"; text: string }
	| {
			type: "done"
			runId: string
			status: "succeeded" | "failed" | "stopped"
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
	 * Searches the knowledge bases and builds the prompt.
	 *
	 * Runs after the stream has opened, like a chat turn's retrieval: everything
	 * that can refuse already happened in `prepare`, and what is left can only
	 * fail — which is something the client can be told about mid-stream.
	 *
	 * A base the version names that has since been deleted is skipped and
	 * reported. The version is an immutable record of what was configured, so it
	 * cannot be corrected, and failing the whole run over one removed base would
	 * make deleting a knowledge base silently break every agent that ever
	 * mentioned it.
	 */
	async gatherContext(workspaceId: string, prepared: PreparedRun): Promise<RunContext> {
		const { version, input } = prepared
		const definition = await findCatalogueModel(
			prepared.selection.provider,
			prepared.selection.model,
		)

		const missingBaseIds: string[] = []
		const baseIds: string[] = []
		for (const baseId of version.knowledgeBaseIds) {
			const exists = await knowledgeService
				.getBase(workspaceId, baseId)
				.then(() => true)
				.catch(() => false)
			if (exists) baseIds.push(baseId)
			else missingBaseIds.push(baseId)
		}

		let retrieved: RetrievedChunk[] = []
		let rerankUsage: RetrievalOutcome["rerankUsage"] = null

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
			rerankUsage = outcome.rerankUsage
		}

		const grounding: Grounding =
			baseIds.length === 0 ? "open" : version.groundedOnly ? "documents" : "documents-open"

		const { messages, used } = assemblePrompt(input.input, retrieved, [], {
			contextWindow: definition?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
			maxOutputTokens: version.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
			grounding,
			instructions: version.instructions,
		})

		const citations: MessageCitation[] = used.map((entry, index) => ({
			index: index + 1,
			chunkId: entry.chunkId,
			documentId: entry.documentId,
			documentName: entry.documentName,
			snippet: entry.content.slice(0, 400),
			score: Number(entry.score.toFixed(4)),
			kind: entry.kind,
			fromPage: entry.fromPage,
			toPage: entry.toPage,
		}))

		return { messages, citations, rerankUsage, missingBaseIds }
	},

	/**
	 * Runs the agent, yielding events as they happen.
	 *
	 * Billing is one `usage_ledger` row per provider call — the reranker and the
	 * generation are charged separately, keyed on
	 * `agent-run:{runId}:step:{seq}`. That reference carries a unique index, so a
	 * step that is somehow charged twice is refused by the database rather than by
	 * this code remembering not to (ADR-029).
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
		let context: RunContext = {
			messages: [],
			citations: [],
			rerankUsage: null,
			missingBaseIds: [],
		}
		let answer = ""
		let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
		let failure: string | undefined
		let stopped = false
		let seq = 0
		let outcome: { credits: number; usage: TokenUsage } | undefined

		/**
		 * Writes the run's steps and its final row, once, whatever ended it.
		 *
		 * This runs in a `finally` rather than after the loop because a generator
		 * suspended at a `yield` is closed by `.return()` when its consumer stops
		 * iterating — a dropped connection, a closed tab — and a `return` completion
		 * is not an exception, so nothing after the loop would run. The answer
		 * already streamed to the user would then exist nowhere (ADR-028).
		 */
		const persist = async () => {
			if (outcome) return
			let credits = 0

			// The reranker ran before a token was generated, so it is charged
			// whether or not the answer succeeded — the call was made either way.
			if (context.rerankUsage && context.rerankUsage.tokens > 0) {
				const reference = `agent-run:${run.id}:step:${seq}`
				const charge = await usageService.recordAndCharge({
					workspaceId,
					projectId: prepared.agent.projectId,
					userId: prepared.actorId,
					operation: "rerank",
					provider: context.rerankUsage.provider,
					model: context.rerankUsage.model,
					inputTokens: context.rerankUsage.tokens,
					reference,
					metadata: {
						agentId: prepared.agent.id,
						runId: run.id,
						tokensEstimated: context.rerankUsage.estimated,
					},
				})
				credits += charge.credits
				await agentRepository.insertStep({
					id: newId(),
					runId: run.id,
					seq,
					kind: "retrieval",
					status: "succeeded",
					provider: context.rerankUsage.provider,
					model: context.rerankUsage.model,
					inputTokens: context.rerankUsage.tokens,
					credits: charge.credits.toFixed(4),
					usageReference: reference,
					output: { citations: context.citations.length },
					finishedAt: new Date(),
				})
				seq += 1
			}

			if (answer.length > 0) {
				/**
				 * A run that ended early never received the provider's usage frame, so
				 * the real counts are unknown — but the provider generated the tokens
				 * and charged Ragenta for them, so passing on nothing would make "stop"
				 * a way to read answers for free. They are estimated, and the usage row
				 * records that they were.
				 */
				const estimated = usage.inputTokens === 0 && usage.outputTokens === 0
				const billed = estimated
					? {
							inputTokens: context.messages.reduce(
								(total, message) => total + estimateTokens(message.content),
								0,
							),
							outputTokens: estimateTokens(answer),
						}
					: usage

				const reference = `agent-run:${run.id}:step:${seq}`
				const charge = await usageService.recordAndCharge({
					workspaceId,
					projectId: prepared.agent.projectId,
					userId: prepared.actorId,
					operation: "agent",
					provider: selection.provider,
					model: selection.model,
					inputTokens: billed.inputTokens,
					outputTokens: billed.outputTokens,
					reference,
					metadata: {
						agentId: prepared.agent.id,
						agentVersion: version.version,
						runId: run.id,
						citations: context.citations.length,
						stopped,
						tokensEstimated: estimated,
					},
				})
				credits += charge.credits
				await agentRepository.insertStep({
					id: newId(),
					runId: run.id,
					seq,
					kind: "model",
					status: "succeeded",
					provider: selection.provider,
					model: selection.model,
					inputTokens: billed.inputTokens,
					outputTokens: billed.outputTokens,
					credits: charge.credits.toFixed(4),
					usageReference: reference,
					output: { characters: answer.length, stopped },
					finishedAt: new Date(),
				})
				seq += 1
				usage = billed
			}

			await agentRepository.updateRun(run.id, {
				// A partial answer is a real answer: the user read it and the provider
				// generated it. `stopped` distinguishes "the user chose this length"
				// from a failure.
				status: answer.length === 0 && !stopped ? "failed" : stopped ? "stopped" : "succeeded",
				output: answer.length > 0 ? answer : null,
				error: failure ? failure.slice(0, 500) : null,
				credits: credits.toFixed(4),
				finishedAt: new Date(),
			})

			outcome = { credits, usage }
		}

		yield { type: "phase", phase: "retrieving" }
		try {
			context = await this.gatherContext(workspaceId, prepared)
		} catch (error) {
			// Retrieval can only fail, never refuse — a provider that will not embed
			// the question, a vector store that is down. The run row is still closed
			// so the list says what went wrong beside it.
			failure = error instanceof Error ? error.message : "Retrieval failed."
			log.error("agent.retrieval_failed", error, { workspaceId, runId: run.id })
			await persist()
			yield { type: "error", message: failure }
			return
		}

		if (context.missingBaseIds.length > 0) {
			yield {
				type: "warning",
				message: `${context.missingBaseIds.length} knowledge base(s) this agent was configured with no longer exist and were skipped.`,
			}
		}

		// Stop is offered from the `start` frame, so it can be pressed while the
		// search is still running. Without this check the run would ignore it and
		// generate an answer nobody asked for any more.
		if (await isStopRequested(workspaceId, run.id)) {
			stopped = true
			await persist()
			await clearStop(workspaceId, run.id)
			yield {
				type: "done",
				runId: run.id,
				status: "stopped",
				credits: outcome?.credits ?? 0,
				usage: { input: 0, output: 0 },
			}
			return
		}

		yield { type: "citations", citations: context.citations }
		yield { type: "phase", phase: "generating" }

		try {
			// Checked between tokens rather than per token: a Redis round trip on
			// every delta would cost more than the generation it is watching.
			let nextStopCheck = Date.now() + STOP_POLL_MS

			for await (const event of prepared.client.streamChat(credential, {
				model: selection.model,
				messages: context.messages,
				temperature: version.temperature === null ? undefined : Number(version.temperature),
				maxTokens: version.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
				signal,
			})) {
				if (event.type === "delta") {
					answer += event.text
					yield { type: "delta", text: event.text }
				} else {
					usage = event.usage
				}

				if (Date.now() >= nextStopCheck) {
					nextStopCheck = Date.now() + STOP_POLL_MS
					if (await isStopRequested(workspaceId, run.id)) {
						stopped = true
						break
					}
				}
			}
		} catch (error) {
			failure = error instanceof Error ? error.message : "The provider call failed."
			log.error("agent.stream_failed", error, { workspaceId, runId: run.id })
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
			status: stopped ? "stopped" : "succeeded",
			credits: outcome?.credits ?? 0,
			usage: { input: usage.inputTokens, output: usage.outputTokens },
		}
	},
}
