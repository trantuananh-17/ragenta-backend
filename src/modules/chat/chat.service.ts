import { findCatalogueModel, requireCredential } from "../../ai/catalogue"
import { chatCapableClient } from "../../ai/clients"
import type { ChatCapableClient, ChatMessage, TokenUsage } from "../../ai/clients"
import { estimateTokens } from "../../ai/tokens"
import type { MessageCitation } from "../../db/schema"
import { EntitlementError, NotFoundError, ValidationError, isAppError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import type { PaginationQuery } from "../../shared/pagination"
import { page } from "../../shared/pagination"
import { billingService } from "../billing/billing.service"
import { knowledgeService } from "../knowledge/knowledge.service"
import { modelService } from "../model/model.service"
import { retrievalService } from "../retrieval/retrieval.service"
import type {
	RetrievalOutcome,
	RetrievedChunk,
	SearchMode,
} from "../retrieval/retrieval.service"
import { resolveRerankModel } from "../../ai/rerank"
import { usageService } from "../usage/usage.service"
import { chatRepository } from "./chat.repository"
import type { ConversationRow } from "./chat.repository"
import { assemblePrompt } from "./prompt"
import { clearStop, isStopRequested, requestStop } from "./stop-signal"
import type {
	CreateConversationInput,
	SendMessageInput,
	UpdateConversationInput,
} from "./chat.dto"

const log = logger.child({ module: "chat" })

/** Turns of history sent with a question. Beyond this the prompt is mostly past. */
const HISTORY_TURNS = 10

/** Reserved for the answer, and the ceiling on what one turn can cost in output. */
const MAX_OUTPUT_TOKENS = 2_000

/** For a model with no context window recorded. Small enough to be safe anywhere. */
const FALLBACK_CONTEXT_WINDOW = 32_000

/**
 * Refuse a turn below this balance rather than mid-stream.
 *
 * A stream that dies halfway through is a worse experience than a refusal, and
 * the exact cost is not knowable until the provider reports its token counts —
 * so this is a floor, not an estimate. Roughly one long premium turn.
 */
const MINIMUM_CREDITS = 5_000

/**
 * How often a generating turn asks whether it has been told to stop.
 *
 * A Redis round trip per token would cost more than the generation it watches;
 * a third of a second is below what anyone perceives as a delay on a button.
 */
const STOP_POLL_MS = 300

/**
 * Everything one turn needs, resolved before generation starts. Named rather
 * than inferred from `prepareTurn`, because a service method that referred to
 * its own return type would make the whole object's type circular.
 */
export interface PreparedTurn {
	conversation: ConversationRow & { additionalKnowledgeBaseIds: string[] }
	/** Narrowed at `prepareTurn`: a provider with no chat adapter is refused there. */
	client: ChatCapableClient
	selection: { provider: string; model: string }
	/** Carried through because retrieval now runs inside the stream, not before it. */
	input: SendMessageInput
	userMessageId: string
	assistantMessageId: string
	actorId: string
}

/** Retrieval and prompt assembly, which happen after the stream has opened. */
interface TurnContext {
	messages: ChatMessage[]
	citations: MessageCitation[]
	rerankUsage: RetrievalOutcome["rerankUsage"]
}

export type ChatStreamEvent =
	/** Sent before any token, so the client can ask for this turn to stop. */
	| { type: "start"; messageId: string }
	/**
	 * Which part of the turn is running.
	 *
	 * Retrieval and reranking happen before a single token exists and take
	 * seconds on a large base, so without this the client has nothing to show but
	 * a spinner that means "something". It is one frame per phase, not progress:
	 * neither search nor generation knows how far along it is.
	 */
	| { type: "phase"; phase: "retrieving" | "generating" }
	| { type: "citations"; citations: MessageCitation[] }
	| { type: "delta"; text: string }
	| {
			type: "done"
			messageId: string
			/** True when the answer is as long as it is because the user said so. */
			stopped: boolean
			credits: number
			usage: { input: number; output: number }
		}
	| { type: "error"; message: string }

export const chatService = {
	async listConversations(workspaceId: string, query: PaginationQuery) {
		const { items, total } = await chatRepository.listConversations(workspaceId, query)
		return page(
			items.map((row) => ({ ...row.conversation, knowledgeBaseName: row.knowledgeBaseName })),
			total,
			query,
		)
	},

	async getConversation(workspaceId: string, conversationId: string) {
		const row = await chatRepository.findConversation(workspaceId, conversationId)
		if (!row) throw new NotFoundError("Conversation")
		return {
			...row,
			additionalKnowledgeBaseIds: await chatRepository.listConversationBaseIds(row.id),
		}
	},

	/**
	 * Proves every knowledge base belongs to this workspace, and that they can be
	 * searched together.
	 *
	 * The ids came from the client and nothing else here would check them. The
	 * embedding comparison is the second half: two bases embedded with different
	 * models produce vectors that are not comparable, so searching them together
	 * would not degrade the ranking, it would invent one. Refusing at the point
	 * the set is chosen is the only place a user can act on it.
	 */
	async assertBasesSearchableTogether(workspaceId: string, baseIds: string[]) {
		const unique = [...new Set(baseIds)]
		if (unique.length === 0) return

		const bases = await Promise.all(
			unique.map((baseId) => knowledgeService.getBase(workspaceId, baseId)),
		)

		const primary = bases[0]
		if (!primary) return

		const mismatched = bases.find(
			(base) =>
				base.embeddingProvider !== primary.embeddingProvider ||
				base.embeddingModel !== primary.embeddingModel,
		)
		if (mismatched) {
			throw new ValidationError(
				`"${mismatched.name}" and "${primary.name}" use different embedding models, so one conversation cannot search both. Use separate conversations, or rebuild one of them on the other's model.`,
			)
		}
	},

	async createConversation(
		workspaceId: string,
		input: CreateConversationInput,
		actorId: string,
	) {
		const baseIds = [
			...(input.knowledgeBaseId ? [input.knowledgeBaseId] : []),
			...input.additionalKnowledgeBaseIds,
		]
		await this.assertBasesSearchableTogether(workspaceId, baseIds)
		if (input.rerank) {
			await resolveRerankModel(input.rerank.provider, input.rerank.model)
		}

		const created = await chatRepository.insertConversation({
			id: newId(),
			organizationId: workspaceId,
			projectId: input.projectId,
			knowledgeBaseId: input.knowledgeBaseId,
			title: input.title,
			searchMode: input.searchMode ?? "hybrid",
			topK: input.topK ?? null,
			similarityThreshold: input.similarityThreshold?.toFixed(3) ?? null,
			vectorWeight: input.vectorWeight?.toFixed(3) ?? null,
			rerankProvider: input.rerank?.provider ?? null,
			rerankModel: input.rerank?.model ?? null,
			createdBy: actorId,
		})

		if (created && input.additionalKnowledgeBaseIds.length > 0) {
			await chatRepository.setConversationBaseIds(
				created.id,
				// The primary base is stored on the conversation row; keeping it in
				// the join table too would make "how many extra bases" ambiguous.
				input.additionalKnowledgeBaseIds.filter((id) => id !== input.knowledgeBaseId),
			)
		}

		return { ...created, additionalKnowledgeBaseIds: input.additionalKnowledgeBaseIds }
	},

	async updateConversation(
		workspaceId: string,
		conversationId: string,
		input: UpdateConversationInput,
	) {
		const existing = await this.getConversation(workspaceId, conversationId)

		const primaryId =
			input.knowledgeBaseId === undefined ? existing.knowledgeBaseId : input.knowledgeBaseId
		const additional = input.additionalKnowledgeBaseIds ?? existing.additionalKnowledgeBaseIds
		await this.assertBasesSearchableTogether(workspaceId, [
			...(primaryId ? [primaryId] : []),
			...additional,
		])
		if (input.rerank) {
			await resolveRerankModel(input.rerank.provider, input.rerank.model)
		}

		const updated = await chatRepository.updateConversation(workspaceId, conversationId, {
			...(input.title !== undefined ? { title: input.title } : {}),
			...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
			...(input.knowledgeBaseId !== undefined
				? { knowledgeBaseId: input.knowledgeBaseId }
				: {}),
			...(input.searchMode !== undefined ? { searchMode: input.searchMode } : {}),
			...(input.topK !== undefined ? { topK: input.topK } : {}),
			...(input.similarityThreshold !== undefined
				? { similarityThreshold: input.similarityThreshold?.toFixed(3) ?? null }
				: {}),
			...(input.vectorWeight !== undefined
				? { vectorWeight: input.vectorWeight?.toFixed(3) ?? null }
				: {}),
			...(input.rerank !== undefined
				? {
						rerankProvider: input.rerank?.provider ?? null,
						rerankModel: input.rerank?.model ?? null,
					}
				: {}),
		})
		if (!updated) throw new NotFoundError("Conversation")

		if (input.additionalKnowledgeBaseIds !== undefined) {
			await chatRepository.setConversationBaseIds(
				conversationId,
				input.additionalKnowledgeBaseIds.filter((id) => id !== primaryId),
			)
		}

		return {
			...updated,
			additionalKnowledgeBaseIds: await chatRepository.listConversationBaseIds(conversationId),
		}
	},

	async deleteConversation(workspaceId: string, conversationId: string) {
		const removed = await chatRepository.deleteConversation(workspaceId, conversationId)
		if (!removed) throw new NotFoundError("Conversation")
		return { id: conversationId }
	},

	async listMessages(workspaceId: string, conversationId: string, query: PaginationQuery) {
		await this.getConversation(workspaceId, conversationId)
		const { items, total } = await chatRepository.listMessages(
			workspaceId,
			conversationId,
			query,
		)
		return page(items, total, query)
	},

	/**
	 * Everything a turn needs before a single token is generated: the model, the
	 * passages, the prompt and the user's own message row.
	 *
	 * Separated from the generation because both the streaming and the blocking
	 * endpoint need it, and because every way a turn can be refused — no credits,
	 * a model the plan does not include, a knowledge base that has gone — should
	 * be refused here, with a status code, rather than as an error frame inside a
	 * stream the client has already started rendering.
	 */
	async prepareTurn(
		workspaceId: string,
		conversationId: string,
		input: SendMessageInput,
		actorId: string,
	): Promise<PreparedTurn> {
		const conversation = await this.getConversation(workspaceId, conversationId)

		const assistantMessageId = newId()
		/**
		 * The question is written before anything that can refuse the turn.
		 *
		 * Every refusal below — no credits, a model outside the plan, a knowledge
		 * base that has been deleted — used to throw ahead of this insert, so the
		 * row was never written and the client dropped its optimistic copy on the
		 * refetch that followed. The user's question vanished from the thread along
		 * with the error, which is the worse of the two losses: the refusal is
		 * fixable in a few clicks, and retyping is the only way back to the
		 * question.
		 */
		const userMessage = await chatRepository.insertMessage({
			id: newId(),
			organizationId: workspaceId,
			conversationId,
			role: "user",
			content: input.content,
			userId: actorId,
		})

		try {
			return await this.buildTurn(
				workspaceId,
				conversation,
				input,
				actorId,
				userMessage?.id ?? newId(),
				assistantMessageId,
			)
		} catch (error) {
			await this.recordRefusedTurn(workspaceId, conversation.id, assistantMessageId, actorId, error)
			throw error
		}
	},

	/**
	 * Leaves the refusal in the thread next to the question that caused it.
	 *
	 * The endpoint still answers with its status code — a 402 for credits is what
	 * the client acts on — but a toast is gone the moment it is dismissed, and
	 * the thread is where the user looks to find out what happened.
	 */
	async recordRefusedTurn(
		workspaceId: string,
		conversationId: string,
		assistantMessageId: string,
		actorId: string,
		error: unknown,
	) {
		// Only domain errors carry a message meant for a customer. Anything else
		// is an internal failure whose text belongs in the logs, not in a thread.
		const reason = isAppError(error)
			? error.message
			: "Something went wrong before the answer could start."

		await chatRepository.insertMessage({
			id: assistantMessageId,
			organizationId: workspaceId,
			conversationId,
			role: "assistant",
			content: "",
			status: "failed",
			error: reason.slice(0, 500),
			userId: actorId,
		})
	},

	async buildTurn(
		workspaceId: string,
		conversation: PreparedTurn["conversation"],
		input: SendMessageInput,
		actorId: string,
		userMessageId: string,
		assistantMessageId: string,
	): Promise<PreparedTurn> {
		const summary = await billingService.getSummary(workspaceId)
		if (summary.credits.total < MINIMUM_CREDITS) {
			throw new EntitlementError(
				"INSUFFICIENT_CREDITS",
				"This workspace does not have enough credits to run a chat turn.",
				{ required: MINIMUM_CREDITS, available: summary.credits.total },
			)
		}

		const selection =
			input.model ??
			(await modelService.resolveChatModel(workspaceId, conversation.projectId ?? undefined))
		if (input.model) {
			await modelService.assertSelectable(workspaceId, selection, "chat")
		}

		const client = chatCapableClient(selection.provider)
		// A provider may have an adapter for only some capabilities — the rerank
		// providers have no chat method at all — so the check is for the method,
		// not for the client.
		if (!client?.streamChat) {
			throw new ValidationError(
				`This deployment cannot run chat with the ${selection.provider} provider.`,
			)
		}

		return {
			conversation,
			client,
			selection,
			input,
			userMessageId,
			assistantMessageId,
			actorId,
		}
	},

	/**
	 * Searches the knowledge bases and builds the prompt.
	 *
	 * Runs after the stream has opened rather than before it, which is a
	 * deliberate reversal: retrieval and reranking are the slowest part of a turn
	 * and used to happen in silence, behind a request that had not answered yet.
	 * Everything that can *refuse* a turn still happens in `prepareTurn`, so a
	 * refusal is still a status code — what moved here is work that can only
	 * fail, and a failure is something the client can be told about mid-stream.
	 */
	async gatherContext(workspaceId: string, turn: PreparedTurn): Promise<TurnContext> {
		const { conversation, input } = turn
		const definition = await findCatalogueModel(turn.selection.provider, turn.selection.model)

		const baseIds = [
			...(conversation.knowledgeBaseId ? [conversation.knowledgeBaseId] : []),
			...conversation.additionalKnowledgeBaseIds,
		]

		let retrieved: RetrievedChunk[] = []
		let rerankUsage: RetrievalOutcome["rerankUsage"] = null

		if (baseIds.length > 0) {
			const outcome = await retrievalService.retrieve({
				workspaceId,
				knowledgeBaseIds: baseIds,
				question: input.content,
				// Per-turn override, then the thread's setting, then the base's.
				topK: input.topK ?? conversation.topK ?? undefined,
				mode: input.searchMode ?? (conversation.searchMode as SearchMode),
				similarityThreshold:
					input.similarityThreshold ??
					(conversation.similarityThreshold === null
						? undefined
						: Number(conversation.similarityThreshold)),
				vectorWeight:
					input.vectorWeight ??
					(conversation.vectorWeight === null
						? undefined
						: Number(conversation.vectorWeight)),
				rerank:
					conversation.rerankProvider && conversation.rerankModel
						? { provider: conversation.rerankProvider, model: conversation.rerankModel }
						: undefined,
				documentIds: input.documentIds,
			})
			retrieved = outcome.chunks
			rerankUsage = outcome.rerankUsage
		}

		const history = (
			// One extra row, because the question being answered was written before
			// this call and would otherwise take a slot in the window it is not part
			// of — it is passed to the prompt separately.
			await chatRepository.listRecentMessages(conversation.id, HISTORY_TURNS * 2 + 1)
		)
			.filter((row) => row.id !== turn.userMessageId)
			// A failed turn left its error on the row and no useful content; feeding
			// it back would teach the model that failing is a normal answer. A
			// stopped one is different: it is a real, shorter answer the user read,
			// and dropping it from the history would make the next turn respond to a
			// conversation that never happened.
			.filter((row) => row.status === "complete" || row.status === "stopped")
			.map<ChatMessage>((row) => ({
				role: row.role === "assistant" ? "assistant" : "user",
				content: row.content,
			}))

		const { messages, used } = assemblePrompt(input.content, retrieved, history, {
			contextWindow: definition?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
			maxOutputTokens: MAX_OUTPUT_TOKENS,
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

		return { messages, citations, rerankUsage }
	},

	/**
	 * Runs the turn, yielding events as they happen.
	 *
	 * The assistant row is written once, at the end, with the whole answer. A row
	 * updated on every delta would be one UPDATE per token; a client that
	 * disconnects mid-stream still gets its answer persisted because the
	 * generator's `finally` runs on abort.
	 *
	 * Billing is from the provider's own token counts, after the fact. A turn
	 * that fails before `done` costs the customer nothing, which is the right way
	 * round — Ragenta absorbs the provider call it already paid for rather than
	 * charging for an answer nobody received.
	 */
	async *streamTurn(
		workspaceId: string,
		turn: PreparedTurn,
		signal?: AbortSignal,
	): AsyncGenerator<ChatStreamEvent> {
		// First, before a token exists: the client needs this id to ask for the
		// turn to stop, and it needs it early enough that pressing stop half a
		// second in already works.
		yield { type: "start", messageId: turn.assistantMessageId }

		const credential = await requireCredential(turn.selection.provider)
		let context: TurnContext = { messages: [], citations: [], rerankUsage: null }
		let answer = ""
		let usage = { inputTokens: 0, outputTokens: 0 }
		let failure: string | undefined
		let stopped = false
		let outcome: { credits: number; usage: TokenUsage } | undefined

		/**
		 * Writes the turn, once, whatever ended it.
		 *
		 * This runs in a `finally` rather than after the loop because a generator
		 * suspended at a `yield` is closed by `.return()` when its consumer stops
		 * iterating — a dropped connection, a closed tab — and a `return`
		 * completion is not an exception, so nothing after the loop would run. The
		 * answer already streamed to the user would then exist nowhere.
		 */
		const persist = async () => {
			if (outcome) return
			outcome = { credits: 0, usage }

			// The reranker ran before a token was generated, so it is charged
			// whether or not the answer succeeded — the call was made either way.
			if (context.rerankUsage && context.rerankUsage.tokens > 0) {
				await usageService.recordAndCharge({
					workspaceId,
					projectId: turn.conversation.projectId,
					userId: turn.actorId,
					operation: "rerank",
					provider: context.rerankUsage.provider,
					model: context.rerankUsage.model,
					inputTokens: context.rerankUsage.tokens,
					reference: `rerank:${turn.assistantMessageId}`,
					metadata: {
						conversationId: turn.conversation.id,
						tokensEstimated: context.rerankUsage.estimated,
					},
				})
			}

			if (answer.length === 0) {
				// Nothing was generated. A stop this early is not a failure — the
				// user asked for it — so it is recorded as one, not as an error the
				// UI should apologise for.
				await chatRepository.insertMessage({
					id: turn.assistantMessageId,
					organizationId: workspaceId,
					conversationId: turn.conversation.id,
					role: "assistant",
					content: "",
					citations: context.citations,
					provider: turn.selection.provider,
					model: turn.selection.model,
					status: stopped ? "stopped" : "failed",
					error: stopped ? null : (failure?.slice(0, 500) ?? "The provider returned nothing."),
					userId: turn.actorId,
				})
				return
			}

			/**
			 * A turn that ended early never received the provider's usage frame, so
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

			const charge = await usageService.recordAndCharge({
				workspaceId,
				projectId: turn.conversation.projectId,
				userId: turn.actorId,
				operation: "chat",
				provider: turn.selection.provider,
				model: turn.selection.model,
				inputTokens: billed.inputTokens,
				outputTokens: billed.outputTokens,
				reference: `chat:${turn.assistantMessageId}`,
				metadata: {
					conversationId: turn.conversation.id,
					knowledgeBaseId: turn.conversation.knowledgeBaseId,
					citations: context.citations.length,
					stopped,
					tokensEstimated: estimated,
				},
			})

			await chatRepository.insertMessage({
				id: turn.assistantMessageId,
				organizationId: workspaceId,
				conversationId: turn.conversation.id,
				role: "assistant",
				content: answer,
				citations: context.citations,
				provider: turn.selection.provider,
				model: turn.selection.model,
				inputTokens: billed.inputTokens,
				outputTokens: billed.outputTokens,
				credits: charge.credits.toFixed(4),
				// A partial answer is a real answer: the user read it, the provider
				// generated it, and it stays in the thread and in the model's history.
				// `stopped` distinguishes "the user chose this length" from a failure.
				status: stopped ? "stopped" : "complete",
				error: failure ? failure.slice(0, 500) : null,
				userId: turn.actorId,
			})

			await chatRepository.updateConversation(workspaceId, turn.conversation.id, {
				lastMessageAt: new Date(),
			})

			outcome = { credits: charge.credits, usage: billed }
		}

		yield { type: "phase", phase: "retrieving" }
		try {
			context = await this.gatherContext(workspaceId, turn)
		} catch (error) {
			// Retrieval can only fail, never refuse — a base that has been deleted,
			// a provider that will not embed the question. The row is still written
			// so the thread keeps the question and says what went wrong beside it.
			failure = error instanceof Error ? error.message : "Retrieval failed."
			log.error("chat.retrieval_failed", error, {
				workspaceId,
				conversationId: turn.conversation.id,
			})
			await persist()
			yield { type: "error", message: failure }
			return
		}

		// Stop is offered from the `start` frame, so it can be pressed while the
		// search is still running. Without this check the turn would ignore it and
		// generate a full answer nobody asked for any more.
		if (await isStopRequested(workspaceId, turn.conversation.id, turn.assistantMessageId)) {
			stopped = true
			await persist()
			await clearStop(workspaceId, turn.conversation.id, turn.assistantMessageId)
			yield {
				type: "done",
				messageId: turn.assistantMessageId,
				stopped: true,
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

			for await (const event of turn.client.streamChat(credential, {
				model: turn.selection.model,
				messages: context.messages,
				maxTokens: MAX_OUTPUT_TOKENS,
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
					if (
						await isStopRequested(
							workspaceId,
							turn.conversation.id,
							turn.assistantMessageId,
						)
					) {
						stopped = true
						break
					}
				}
			}
		} catch (error) {
			failure = error instanceof Error ? error.message : "The provider call failed."
			log.error("chat.stream_failed", error, {
				workspaceId,
				conversationId: turn.conversation.id,
			})
		} finally {
			await persist()
			await clearStop(workspaceId, turn.conversation.id, turn.assistantMessageId)
		}

		if (failure && answer.length === 0) {
			yield { type: "error", message: failure }
			return
		}

		yield {
			type: "done",
			messageId: turn.assistantMessageId,
			stopped,
			credits: outcome?.credits ?? 0,
			usage: {
				input: outcome?.usage.inputTokens ?? 0,
				output: outcome?.usage.outputTokens ?? 0,
			},
		}
	},

	/**
	 * Asks a turn that is generating to stop.
	 *
	 * Deliberately not "abort the client's request". The generating request is
	 * the only thing that can save the partial answer, so it is told to finish
	 * early rather than killed — it stops pulling from the provider, writes what
	 * it has, and sends its normal `done` frame. The text on screen survives
	 * because it is in the database before the client stops reading.
	 *
	 * The message id has no row yet — it is created when the turn ends — so this
	 * cannot be authorised against it. The conversation is what is checked, which
	 * is the resource boundary that matters: a caller who is not in this
	 * workspace gets a 404 from `getConversation`.
	 */
	async stopTurn(workspaceId: string, conversationId: string, messageId: string) {
		await this.getConversation(workspaceId, conversationId)
		await requestStop(workspaceId, conversationId, messageId)
		return { messageId, stopRequested: true }
	},

	/** The same turn without streaming, for clients that would rather wait. */
	async completeTurn(
		workspaceId: string,
		turn: PreparedTurn,
	) {
		let answer = ""
		let citations: MessageCitation[] = []
		let result: Extract<ChatStreamEvent, { type: "done" }> | undefined
		let failure: string | undefined

		for await (const event of this.streamTurn(workspaceId, turn)) {
			if (event.type === "delta") answer += event.text
			if (event.type === "citations") citations = event.citations
			if (event.type === "done") result = event
			if (event.type === "error") failure = event.message
		}

		if (!result) {
			throw new ValidationError(failure ?? "The provider call failed.")
		}

		return {
			messageId: result.messageId,
			content: answer,
			citations,
			provider: turn.selection.provider,
			model: turn.selection.model,
			credits: result.credits,
			usage: result.usage,
		}
	},
}
