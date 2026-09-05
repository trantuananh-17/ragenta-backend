import { findCatalogueModel, requireCredential } from "../../ai/catalogue"
import { providerClient } from "../../ai/clients"
import type { ChatMessage, ProviderClient } from "../../ai/clients"
import type { MessageCitation } from "../../db/schema"
import { EntitlementError, NotFoundError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import type { PaginationQuery } from "../../shared/pagination"
import { page } from "../../shared/pagination"
import { billingService } from "../billing/billing.service"
import { knowledgeService } from "../knowledge/knowledge.service"
import { modelService } from "../model/model.service"
import { retrievalService } from "../retrieval/retrieval.service"
import type { RetrievedChunk } from "../retrieval/retrieval.service"
import { usageService } from "../usage/usage.service"
import { chatRepository } from "./chat.repository"
import type { ConversationRow } from "./chat.repository"
import { assemblePrompt } from "./prompt"
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
 * Everything one turn needs, resolved before generation starts. Named rather
 * than inferred from `prepareTurn`, because a service method that referred to
 * its own return type would make the whole object's type circular.
 */
export interface PreparedTurn {
	conversation: ConversationRow
	client: ProviderClient
	selection: { provider: string; model: string }
	messages: ChatMessage[]
	citations: MessageCitation[]
	userMessageId: string
	assistantMessageId: string
	actorId: string
}

export type ChatStreamEvent =
	| { type: "citations"; citations: MessageCitation[] }
	| { type: "delta"; text: string }
	| { type: "done"; messageId: string; credits: number; usage: { input: number; output: number } }
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
		return row
	},

	async createConversation(
		workspaceId: string,
		input: CreateConversationInput,
		actorId: string,
	) {
		// Proves the knowledge base belongs to this workspace before it is stored:
		// the id came from the client, and nothing else here would check it.
		if (input.knowledgeBaseId) {
			await knowledgeService.getBase(workspaceId, input.knowledgeBaseId)
		}

		return chatRepository.insertConversation({
			id: newId(),
			organizationId: workspaceId,
			projectId: input.projectId,
			knowledgeBaseId: input.knowledgeBaseId,
			title: input.title,
			createdBy: actorId,
		})
	},

	async updateConversation(
		workspaceId: string,
		conversationId: string,
		input: UpdateConversationInput,
	) {
		if (input.knowledgeBaseId) {
			await knowledgeService.getBase(workspaceId, input.knowledgeBaseId)
		}
		const updated = await chatRepository.updateConversation(
			workspaceId,
			conversationId,
			input,
		)
		if (!updated) throw new NotFoundError("Conversation")
		return updated
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

		const definition = await findCatalogueModel(selection.provider, selection.model)
		const client = providerClient(selection.provider)
		if (!client) {
			throw new ValidationError(
				`This deployment has no client for the ${selection.provider} provider.`,
			)
		}

		let retrieved: RetrievedChunk[] = []
		if (conversation.knowledgeBaseId) {
			retrieved = await retrievalService.retrieve({
				workspaceId,
				knowledgeBaseId: conversation.knowledgeBaseId,
				question: input.content,
				topK: input.topK,
				documentIds: input.documentIds,
			})
		}

		const history = (
			await chatRepository.listRecentMessages(conversationId, HISTORY_TURNS * 2)
		)
			// A failed turn left its error on the row and no useful content; feeding
			// it back would teach the model that failing is a normal answer.
			.filter((row) => row.status === "complete")
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
		}))

		const userMessage = await chatRepository.insertMessage({
			id: newId(),
			organizationId: workspaceId,
			conversationId,
			role: "user",
			content: input.content,
			userId: actorId,
		})

		const assistantMessageId = newId()

		return {
			conversation,
			client,
			selection,
			messages,
			citations,
			userMessageId: userMessage?.id ?? newId(),
			assistantMessageId,
			actorId,
		}
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
		yield { type: "citations", citations: turn.citations }

		const credential = await requireCredential(turn.selection.provider)
		let answer = ""
		let usage = { inputTokens: 0, outputTokens: 0 }
		let failure: string | undefined

		try {
			for await (const event of turn.client.streamChat(credential, {
				model: turn.selection.model,
				messages: turn.messages,
				maxTokens: MAX_OUTPUT_TOKENS,
				signal,
			})) {
				if (event.type === "delta") {
					answer += event.text
					yield { type: "delta", text: event.text }
				} else {
					usage = event.usage
				}
			}
		} catch (error) {
			failure = error instanceof Error ? error.message : "The provider call failed."
			log.error("chat.stream_failed", error, {
				workspaceId,
				conversationId: turn.conversation.id,
			})
		}

		let credits = 0

		if (failure && answer.length === 0) {
			await chatRepository.insertMessage({
				id: turn.assistantMessageId,
				organizationId: workspaceId,
				conversationId: turn.conversation.id,
				role: "assistant",
				content: "",
				citations: turn.citations,
				provider: turn.selection.provider,
				model: turn.selection.model,
				status: "failed",
				error: failure.slice(0, 500),
				userId: turn.actorId,
			})
			yield { type: "error", message: failure }
			return
		}

		const charge = await usageService.recordAndCharge({
			workspaceId,
			projectId: turn.conversation.projectId,
			userId: turn.actorId,
			operation: "chat",
			provider: turn.selection.provider,
			model: turn.selection.model,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			reference: `chat:${turn.assistantMessageId}`,
			metadata: {
				conversationId: turn.conversation.id,
				knowledgeBaseId: turn.conversation.knowledgeBaseId,
				citations: turn.citations.length,
			},
		})
		credits = charge.credits

		await chatRepository.insertMessage({
			id: turn.assistantMessageId,
			organizationId: workspaceId,
			conversationId: turn.conversation.id,
			role: "assistant",
			content: answer,
			citations: turn.citations,
			provider: turn.selection.provider,
			model: turn.selection.model,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			credits: credits.toFixed(4),
			// A stream cut short still produced a real, billable partial answer, so
			// it is stored complete rather than failed — with the reason recorded.
			status: "complete",
			error: failure ? failure.slice(0, 500) : null,
			userId: turn.actorId,
		})

		await chatRepository.updateConversation(workspaceId, turn.conversation.id, {
			lastMessageAt: new Date(),
		})

		yield {
			type: "done",
			messageId: turn.assistantMessageId,
			credits,
			usage: { input: usage.inputTokens, output: usage.outputTokens },
		}
	},

	/** The same turn without streaming, for clients that would rather wait. */
	async completeTurn(
		workspaceId: string,
		turn: PreparedTurn,
	) {
		let answer = ""
		let result: Extract<ChatStreamEvent, { type: "done" }> | undefined
		let failure: string | undefined

		for await (const event of this.streamTurn(workspaceId, turn)) {
			if (event.type === "delta") answer += event.text
			if (event.type === "done") result = event
			if (event.type === "error") failure = event.message
		}

		if (!result) {
			throw new ValidationError(failure ?? "The provider call failed.")
		}

		return {
			messageId: result.messageId,
			content: answer,
			citations: turn.citations,
			provider: turn.selection.provider,
			model: turn.selection.model,
			credits: result.credits,
			usage: result.usage,
		}
	},
}
