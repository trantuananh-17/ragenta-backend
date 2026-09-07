import { findCatalogueModel, requireCredential } from "../../ai/catalogue"
import { chatCapableClient } from "../../ai/clients"
import type { ChatCapableClient, ChatMessage, ImagePart, TokenUsage } from "../../ai/clients"
import { estimateTokens } from "../../ai/tokens"
import type { MessageCitation } from "../../db/schema"
import {
	ConflictError,
	EntitlementError,
	NotFoundError,
	ValidationError,
	isAppError,
} from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import type { PaginationQuery } from "../../shared/pagination"
import { page } from "../../shared/pagination"
import { getObject } from "../../storage/objects"
import { attachmentService } from "../attachment/attachment.service"
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
import {
	MAX_TURN_IMAGES,
	planTurnImages,
	toMessageAttachment,
	withExtractedText,
} from "./attachments"
import type { TurnAttachment } from "./attachments"
import { chatRepository } from "./chat.repository"
import type { AttachmentRow, ConversationRow } from "./chat.repository"
import { assemblePrompt } from "./prompt"
import type { Grounding } from "./prompt"
import { refineQuery } from "./refine"
import { clearStop, isStopRequested, requestStop } from "./stop-signal"
import type {
	CreateConversationInput,
	SendMessageInput,
	UpdateConversationInput,
} from "./chat.dto"

const log = logger.child({ module: "chat" })

/** Turns of history sent with a question. Beyond this the prompt is mostly past. */
const HISTORY_TURNS = 10

/** What a step that did not run consumed. */
const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 }

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
	/**
	 * The images this question carries, already checked against the workspace and
	 * against the model. Rows rather than ids: they are read to refuse the turn,
	 * and re-reading them when the prompt is built would be the second read of
	 * something that cannot have changed in between.
	 */
	attachments: AttachmentRow[]
	userMessageId: string
	assistantMessageId: string
	actorId: string
}

/** Retrieval and prompt assembly, which happen after the stream has opened. */
interface TurnContext {
	messages: ChatMessage[]
	citations: MessageCitation[]
	rerankUsage: RetrievalOutcome["rerankUsage"]
	/** Set only when the follow-up was actually rewritten, and only to show it. */
	searchedFor: string | null
	/** The rewrite is a model call on the customer's model, so it is charged. */
	refineUsage: TokenUsage
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
	/**
	 * The standalone question retrieval actually searched for, when it differs
	 * from what was typed. Shown rather than hidden: a rewrite that misreads the
	 * thread is otherwise invisible, and the user is the only one who can see
	 * that it went wrong.
	 */
	| { type: "query"; question: string }
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

/** What the images of a turn contribute, once the cap has been applied. */
interface CarriedImages {
	/** Per earlier message: the bytes it still sends, and the text standing in for the rest. */
	byMessage: Map<string, { images: ImagePart[]; transcribed: TurnAttachment[] }>
	/** The current question's own images, in the order they were attached. */
	current: ImagePart[]
}

function groupByMessageId(rows: AttachmentRow[]): Map<string, AttachmentRow[]> {
	const grouped = new Map<string, AttachmentRow[]>()
	for (const row of rows) {
		if (!row.messageId) continue
		const existing = grouped.get(row.messageId)
		if (existing) existing.push(row)
		else grouped.set(row.messageId, [row])
	}
	return grouped
}

function toTurnAttachment(row: AttachmentRow): TurnAttachment {
	const text = row.extracted?.text?.trim()
	return {
		id: row.id,
		fileName: row.fileName,
		mimeType: row.mimeType,
		kind: row.kind,
		extractedText: text ? text : null,
	}
}

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

	async createConversation(
		workspaceId: string,
		input: CreateConversationInput,
		actorId: string,
	) {
		const baseIds = [
			...(input.knowledgeBaseId ? [input.knowledgeBaseId] : []),
			...input.additionalKnowledgeBaseIds,
		]
		await knowledgeService.assertBasesSearchableTogether(workspaceId, baseIds)
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
			groundedOnly: input.groundedOnly ?? true,
			refineFollowUps: input.refineFollowUps ?? true,
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
		await knowledgeService.assertBasesSearchableTogether(workspaceId, [
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
			...(input.groundedOnly !== undefined ? { groundedOnly: input.groundedOnly } : {}),
			...(input.refineFollowUps !== undefined
				? { refineFollowUps: input.refineFollowUps }
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

		// One extra query for the page rather than a join: a message has no
		// attachment far more often than it has one, and a join would multiply
		// every row of the transcript to carry the exception.
		const attachments = groupByMessageId(
			await chatRepository.listAttachmentsForMessages(
				workspaceId,
				items.map((row) => row.id),
			),
		)

		return page(
			items.map((row) => ({
				...row,
				attachments: (attachments.get(row.id) ?? []).map(toMessageAttachment),
			})),
			total,
			query,
		)
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

		const userMessageId = userMessage?.id ?? newId()

		try {
			const turn = await this.buildTurn(
				workspaceId,
				conversation,
				input,
				actorId,
				userMessageId,
				assistantMessageId,
			)

			/**
			 * The images are claimed only once the turn has survived every refusal.
			 *
			 * An attachment id is single-use, so binding it before the credit check
			 * would spend it on a turn that never ran and leave the user with an
			 * image they cannot re-send. The message row is written first for the
			 * opposite reason — the typed question is not recoverable, an unbound
			 * upload is.
			 */
			await this.bindAttachments(workspaceId, conversation.id, userMessageId, turn.attachments)
			return turn
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
			attachments: await this.resolveAttachments(
				workspaceId,
				input.attachmentIds ?? [],
				selection,
				client,
			),
			userMessageId,
			assistantMessageId,
			actorId,
		}
	},

	/**
	 * The images a turn claims, checked before a token is generated.
	 *
	 * Every refusal here is a status code for the same reason the credit check
	 * above is one: the client can act on "that model cannot see" — switch model,
	 * remove the image — and cannot act on an error frame that arrives after the
	 * UI has already started rendering an answer.
	 */
	async resolveAttachments(
		workspaceId: string,
		attachmentIds: string[],
		selection: { provider: string; model: string },
		client: ChatCapableClient,
	): Promise<AttachmentRow[]> {
		if (attachmentIds.length === 0) return []

		const rows = await Promise.all(
			// Read through the attachment service, which scopes every read to the
			// workspace. Holding an id is not evidence of being allowed to send it.
			[...new Set(attachmentIds)].map((id) => attachmentService.findOrFail(workspaceId, id)),
		)

		for (const row of rows) {
			if (row.kind !== "image" && row.kind !== "audio") {
				throw new ValidationError(
					`"${row.fileName}" cannot be attached to a message. Attach an image or a recording.`,
				)
			}
			// A recording reaches the model as its transcript — no chat adapter here
			// takes audio on the wire — so one that has not been transcribed would
			// arrive as a filename and nothing else. Refusing is better than
			// answering about a recording the model never heard.
			if (row.kind === "audio" && !row.extracted?.text?.trim()) {
				throw new ValidationError(
					`"${row.fileName}" has not been transcribed yet. Transcribe it before sending it.`,
				)
			}
			if (row.messageId) {
				throw new ConflictError(
					`"${row.fileName}" has already been sent. Upload it again to send it a second time.`,
				)
			}
		}

		// Only images need a model that can see. A turn carrying nothing but a
		// voice note is ordinary text by the time it reaches the provider, and
		// refusing it for want of vision would be refusing a feature it does not
		// use.
		if (!rows.some((row) => row.kind === "image")) return rows

		const definition = await findCatalogueModel(selection.provider, selection.model)
		// Two separate things, and both have to be true: the model has to be able
		// to see, and this deployment's adapter has to actually put the image on
		// the wire. Either one missing means the model answers about a picture it
		// never received, fluently and billably, with nothing in the reply to say
		// so — which is why neither is inferred.
		if (!definition?.vision || !client.supportsVision) {
			throw new ValidationError(
				`${selection.model} cannot read images. Choose a model that can, or send the message without its attachments.`,
			)
		}

		return rows
	},

	/**
	 * Hands the uploaded images to the message that was just written.
	 *
	 * The bind is conditional on the row still being unbound, so a second send
	 * racing on the same id loses here rather than producing two messages that
	 * point at one image.
	 */
	async bindAttachments(
		workspaceId: string,
		conversationId: string,
		messageId: string,
		attachments: AttachmentRow[],
	) {
		if (attachments.length === 0) return

		const bound = await chatRepository.bindAttachments(
			workspaceId,
			conversationId,
			messageId,
			attachments.map((row) => row.id),
		)
		if (bound.length !== attachments.length) {
			throw new ConflictError(
				"One of these images was sent in another message. Upload it again to send it here.",
			)
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

		/**
		 * An image sent with no caption has nothing to search for. Embedding an
		 * empty string returns whichever passages happen to sit nearest the origin,
		 * and the grounded prompt would then tell the model to answer out of them —
		 * when the question is the picture.
		 */
		const searchable = baseIds.length > 0 && input.content.length > 0

		const historyRows = (
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

		const images = await this.gatherImages(
			workspaceId,
			turn,
			historyRows.map((row) => row.id),
			definition?.vision === true,
		)

		const history = historyRows.map<ChatMessage>((row) => {
			const carried = images.byMessage.get(row.id)
			return {
				role: row.role === "assistant" ? "assistant" : "user",
				content: withExtractedText(row.content, carried?.transcribed ?? []),
				...(carried && carried.images.length > 0 ? { images: carried.images } : {}),
			}
		})

		/**
		 * The question is rewritten for *retrieval only*, never for the prompt.
		 *
		 * The model is given the real thread and the words the user actually typed,
		 * because that is what it should be answering. Retrieval gets one string
		 * with no conversation around it, and that is the half a follow-up breaks.
		 * Skipped without retrieval attached — there is nothing to search, so the
		 * call would be paid for and thrown away.
		 */
		const refined =
			searchable && conversation.refineFollowUps
				? await refineQuery({
						client: turn.client,
						credential: await requireCredential(turn.selection.provider),
						model: turn.selection.model,
						question: input.content,
						history,
					})
				: { question: input.content, keywords: [], rewritten: false, usage: EMPTY_USAGE }

		let retrieved: RetrievedChunk[] = []
		let rerankUsage: RetrievalOutcome["rerankUsage"] = null

		if (searchable) {
			const outcome = await retrievalService.retrieve({
				workspaceId,
				knowledgeBaseIds: baseIds,
				question: refined.question,
				keywords: refined.keywords,
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

		const grounding: Grounding = !searchable
			? "open"
			: conversation.groundedOnly
				? "documents"
				: "documents-open"

		const { messages, used } = assemblePrompt(input.content, retrieved, history, {
			contextWindow: definition?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			grounding,
		})

		// Attached after assembly rather than passed into it: `assemblePrompt` owns
		// the text budget and an image has no length it could budget against.
		const question = messages.at(-1)
		if (question && images.current.length > 0) question.images = images.current

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

		return {
			messages,
			citations,
			rerankUsage,
			searchedFor: refined.rewritten ? refined.question : null,
			refineUsage: refined.usage,
		}
	},

	/**
	 * Loads the bytes of every image this turn will send.
	 *
	 * Inlined rather than linked because a presigned MinIO URL is not reachable
	 * from a provider's network (`ImagePart`), so the bytes travel through this
	 * process on every turn that carries them. `planTurnImages` decides which
	 * ones those are and why.
	 */
	async gatherImages(
		workspaceId: string,
		turn: PreparedTurn,
		historyMessageIds: string[],
		canSeeImages: boolean,
	): Promise<CarriedImages> {
		const empty: CarriedImages = { byMessage: new Map(), current: [] }
		if (turn.attachments.length === 0 && historyMessageIds.length === 0) return empty

		const historyRows = (
			await chatRepository.listAttachmentsForMessages(workspaceId, historyMessageIds)
		).filter(
			(row) => (row.kind === "image" || row.kind === "audio") && row.status === "ready",
		)
		if (turn.attachments.length === 0 && historyRows.length === 0) return empty

		const plan = planTurnImages(
			turn.attachments.map(toTurnAttachment),
			historyRows.map(toTurnAttachment),
			{ canSeeImages },
		)
		if (plan.dropped.length > 0) {
			log.info("chat.images_capped", {
				conversationId: turn.conversation.id,
				dropped: plan.dropped.length,
				limit: MAX_TURN_IMAGES,
				canSeeImages,
			})
		}

		const rowsById = new Map(
			[...historyRows, ...turn.attachments].map((row) => [row.id, row] as const),
		)
		const currentIds = new Set(turn.attachments.map((row) => row.id))

		const loaded = await Promise.all(
			plan.inline.map(async (entry) => {
				const row = rowsById.get(entry.id)
				if (!row) return null
				try {
					const bytes = await getObject(row.storageKey)
					return [
						row.id,
						{ mediaType: row.mimeType, dataBase64: bytes.toString("base64") },
					] as const
				} catch (error) {
					// An image the question is about *is* the question, so a turn that
					// cannot read it fails rather than answering about something the
					// user did not send. An older one is only context: the thread is
					// still worth continuing without it.
					if (currentIds.has(row.id)) throw error
					log.warn("chat.attachment_unreadable", {
						attachmentId: row.id,
						message: error instanceof Error ? error.message : "unknown",
					})
					return null
				}
			}),
		)

		const parts = new Map(loaded.filter((entry) => entry !== null))
		const transcribedIds = new Set(plan.transcribed.map((entry) => entry.id))
		const byMessage: CarriedImages["byMessage"] = new Map()

		for (const row of historyRows) {
			if (!row.messageId) continue
			const part = parts.get(row.id)
			if (!part && !transcribedIds.has(row.id)) continue

			const carried = byMessage.get(row.messageId) ?? { images: [], transcribed: [] }
			if (part) carried.images.push(part)
			else carried.transcribed.push(toTurnAttachment(row))
			byMessage.set(row.messageId, carried)
		}

		return {
			byMessage,
			current: turn.attachments
				.map((row) => parts.get(row.id))
				.filter((part) => part !== undefined),
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
		// First, before a token exists: the client needs this id to ask for the
		// turn to stop, and it needs it early enough that pressing stop half a
		// second in already works.
		yield { type: "start", messageId: turn.assistantMessageId }

		const credential = await requireCredential(turn.selection.provider)
		let context: TurnContext = {
			messages: [],
			citations: [],
			rerankUsage: null,
			searchedFor: null,
			refineUsage: EMPTY_USAGE,
		}
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

			/**
			 * The rewrite is a call on the customer's own chat model. The provider
			 * billed for it the moment it answered, so it is charged whatever
			 * happened next — the same rule the reranker above follows.
			 */
			if (context.refineUsage.inputTokens + context.refineUsage.outputTokens > 0) {
				await usageService.recordAndCharge({
					workspaceId,
					projectId: turn.conversation.projectId,
					userId: turn.actorId,
					operation: "chat",
					provider: turn.selection.provider,
					model: turn.selection.model,
					inputTokens: context.refineUsage.inputTokens,
					outputTokens: context.refineUsage.outputTokens,
					reference: `refine:${turn.assistantMessageId}`,
					metadata: {
						conversationId: turn.conversation.id,
						step: "question_refinement",
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
			 *
			 * `estimateTokens` counts characters and knows nothing about images, so a
			 * turn that carried one and ended early is under-billed by whatever the
			 * provider charges for the picture. Left alone deliberately: this path
			 * only runs when the provider never reported its counts, every other turn
			 * bills from what the provider actually said, and the estimator is a
			 * sizing tool shared with chunking and prompt budgeting rather than a
			 * billing one.
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

		if (context.searchedFor) yield { type: "query", question: context.searchedFor }
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
				} else if (event.type === "done") {
					usage = event.usage
				}
				// A `tool_call` cannot arrive here: chat offers no tools. Ignored
				// rather than asserted, because a model that invented one is not a
				// reason to fail an answer the user is already reading.

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
