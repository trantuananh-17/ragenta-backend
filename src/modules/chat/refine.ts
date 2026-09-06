import type { ChatMessage, ProviderClient, ProviderCredential, TokenUsage } from "../../ai/clients"
import { logger } from "../../shared/logger"

const log = logger.child({ module: "chat.refine" })

/** Enough for a rewritten question and a handful of keywords, and no more. */
const MAX_REFINE_TOKENS = 300

/**
 * Turning a follow-up into a question that can be searched on its own.
 *
 * This is RAGFlow's `refine_multiturn` step (`full_question` in
 * `rag/prompts.py`), and it exists because retrieval and generation read the
 * conversation differently. The model is handed the whole thread, so "how much
 * is that one?" is perfectly clear to it. Retrieval is handed one string and
 * embeds it — and the vector for "how much is that one?" is close to nothing in
 * the corpus, because the subject of the question is in the previous turn.
 *
 * RAGFlow makes two calls here: one to rewrite the question, a second
 * (`keyword_extraction`) to pull search terms out of it. They are one call here.
 * The two prompts read the same input and produce answers of a few dozen tokens;
 * paying twice the latency and twice the round trip to keep them apart buys
 * nothing when one response can carry both fields.
 *
 * Everything about this step is best-effort. It runs before retrieval, on a
 * question that is already usable, so any failure — a provider timeout, a model
 * that ignores the format — falls back to the original question rather than
 * failing a turn the user could otherwise have had.
 */
const SYSTEM_PROMPT = `You rewrite the final question of a conversation so that it can be understood on its own, with no earlier turns.

Reply with JSON only, in this exact shape:
{"question": "...", "keywords": ["...", "..."]}

Rules for "question":
- Replace every reference that points backwards — "it", "that one", "the second option", "và cái kia" — with the thing it refers to, taken from the conversation.
- Change nothing else. Keep the asker's own language, wording and level of detail.
- If the final question already stands alone, repeat it unchanged.
- Never answer it, never expand it into several questions, and never add a fact the conversation does not contain.

Rules for "keywords":
- The words a keyword search would need: names, product terms, error codes, identifiers, numbers.
- Between zero and eight, taken from the question itself. No generic words ("what", "price", "document").`

export interface RefinedQuery {
	/** What retrieval should search for — the original question when nothing changed. */
	question: string
	/** Extra terms for the lexical half of the search. Never used for the vector. */
	keywords: string[]
	/** True only when the text actually differs, so a caller can show the rewrite. */
	rewritten: boolean
	usage: TokenUsage
}

/**
 * Pulls the JSON object out of a reply that may be fenced, prefixed, or both.
 * Models comply with "JSON only" often but not always, and the fallback for an
 * unparseable reply is the same as for a failed call, so this stays forgiving.
 */
function parseReply(text: string): { question?: unknown; keywords?: unknown } | null {
	const start = text.indexOf("{")
	const end = text.lastIndexOf("}")
	if (start === -1 || end <= start) return null

	try {
		const parsed: unknown = JSON.parse(text.slice(start, end + 1))
		return typeof parsed === "object" && parsed !== null ? parsed : null
	} catch {
		return null
	}
}

export async function refineQuery(input: {
	client: ProviderClient
	credential: ProviderCredential
	model: string
	question: string
	/** Oldest first, excluding the question being asked. */
	history: ChatMessage[]
}): Promise<RefinedQuery> {
	const unchanged: RefinedQuery = {
		question: input.question,
		keywords: [],
		rewritten: false,
		usage: { inputTokens: 0, outputTokens: 0 },
	}

	// Nothing to resolve against, and no adapter to ask: both mean the question
	// is already the best query available.
	if (input.history.length === 0 || !input.client.chat) return unchanged

	const conversation = input.history
		.map((entry) => `${entry.role === "assistant" ? "Assistant" : "User"}: ${entry.content}`)
		.join("\n")

	try {
		const result = await input.client.chat(input.credential, {
			model: input.model,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{
					role: "user",
					content: `Conversation so far:\n${conversation}\n\nFinal question: ${input.question}`,
				},
			],
			temperature: 0,
			maxTokens: MAX_REFINE_TOKENS,
		})

		const parsed = parseReply(result.text)
		const question =
			typeof parsed?.question === "string" && parsed.question.trim().length > 0
				? parsed.question.trim()
				: input.question

		const keywords = Array.isArray(parsed?.keywords)
			? parsed.keywords
					.filter((entry): entry is string => typeof entry === "string")
					.map((entry) => entry.trim())
					.filter((entry) => entry.length > 0)
					.slice(0, 8)
			: []

		return {
			question,
			keywords,
			rewritten: question !== input.question,
			usage: result.usage,
		}
	} catch (error) {
		// A question that was going to be searched as typed is still searchable as
		// typed. Logged rather than surfaced: the turn continues normally.
		log.warn("chat.refine_failed", {
			model: input.model,
			message: error instanceof Error ? error.message : "unknown",
		})
		return unchanged
	}
}
