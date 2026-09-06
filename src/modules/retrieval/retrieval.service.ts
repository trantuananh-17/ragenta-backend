import { embedTexts, resolveEmbeddingModel } from "../../ai/embed"
import { rerankPassages, resolveRerankModel } from "../../ai/rerank"
import { ValidationError } from "../../shared/errors"
import { NotFoundError } from "../../shared/errors"
import { logger } from "../../shared/logger"
import { searchChunks } from "../../vector/qdrant"
import { knowledgeRepository } from "../knowledge/knowledge.repository"

const log = logger.child({ module: "retrieval" })

/**
 * Hybrid retrieval.
 *
 * The shape is RAGFlow's (`rag/nlp/search.py`, `Dealer.retrieval`): run a dense
 * search and a lexical search over the same corpus, score every candidate on
 * both, fuse the two with a weight, threshold, and return the top passages.
 * Neither half is sufficient alone — dense search misses an exact product code
 * or an error number, lexical search misses a question phrased in words the
 * document never uses.
 *
 * What is *not* ported is how RAGFlow computes the lexical half. It ships a
 * Chinese tokenizer, a term-weight model and a synonym dictionary, and builds a
 * weighted boolean query out of them. Postgres already has an inverted index and
 * `ts_rank_cd`, which weights by term proximity — a different implementation of
 * the same signal, and one that does not need a second search cluster in the
 * stack. The fusion, the weight and the threshold are RAGFlow's.
 *
 * Three things sit on top of that, each of which RAGFlow also has and each of
 * which is a real choice rather than a knob:
 *
 *  - **Search mode.** Vector-only for a question phrased in the asker's own
 *    words, keyword-only for a part number or an error code, hybrid otherwise.
 *  - **Several knowledge bases at once.** A question about onboarding may be
 *    answered by the handbook or the benefits policy, and making the user guess
 *    which is not a product.
 *  - **Reranking.** A cross-encoder reads the question and a passage together
 *    and scores the pair, where both halves above score them independently. It
 *    is strictly better and strictly more expensive, so it runs over the
 *    candidates fusion already chose.
 */
export const DEFAULT_TOP_K = 6

/**
 * How much of the score comes from the vector. RAGFlow's `retrieval` defaults to
 * 0.3 for the vector and 0.7 for the terms; its chat path passes 0.7 the other
 * way. 0.7 vector is the right default for a question-answering product — the
 * questions are natural language, and lexical matching is the tiebreaker rather
 * than the driver. Stored per knowledge base, overridable per conversation.
 */
export const DEFAULT_VECTOR_WEIGHT = 0.7

/** Below this a passage is noise. RAGFlow's `similarity_threshold` default. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.2

/**
 * Candidates pulled from each half before fusion. Wider than `topK` on purpose:
 * a passage ranked 20th by vector and 2nd by terms should be able to win, and it
 * cannot if it was never a candidate. It is also the reranker's input set —
 * a reranker given six passages can only reorder six.
 */
const CANDIDATE_MULTIPLIER = 5
const MIN_CANDIDATES = 30

export type SearchMode = "hybrid" | "vector" | "keyword"

export interface RetrievedChunk {
	chunkId: string
	documentId: string
	documentName: string
	knowledgeBaseId: string
	ordinal: number
	content: string
	/** passage | qa | row | summary. A `summary` was written by a model, not by the document. */
	kind: string
	/** 0 is a real passage; above 0 is a summary node from the RAPTOR tree. */
	level: number
	fromPage: number | null
	toPage: number | null
	score: number
	vectorScore: number
	termScore: number
	/** The reranker's own score, when one ran. It is what `score` was replaced by. */
	rerankScore: number | null
}

export interface RetrieveOptions {
	workspaceId: string
	/** One or more bases, all of which must share an embedding model. */
	knowledgeBaseIds: string[]
	question: string
	/**
	 * Extra search terms for the lexical half only.
	 *
	 * RAGFlow appends its extracted keywords to the query string, which feeds them
	 * to both halves. They are kept off the vector here on purpose: an embedding of
	 * "question + a list of nouns" is not the embedding of the question, and the
	 * dense half is the one that was already working. Term search is where a
	 * repeated product code earns its weight.
	 */
	keywords?: string[]
	topK?: number
	similarityThreshold?: number
	vectorWeight?: number
	mode?: SearchMode
	/** Narrows retrieval to specific documents. Empty or absent means the whole base. */
	documentIds?: string[]
	rerank?: { provider: string; model: string } | null
}

export interface RetrievalOutcome {
	chunks: RetrievedChunk[]
	/** Charged by the caller — the reranker is a provider call like any other. */
	rerankUsage: { provider: string; model: string; tokens: number; estimated: boolean } | null
}

/**
 * `ts_rank_cd` returns an unbounded positive number, and a cosine similarity is
 * in [0, 1]. Adding them directly would let one long document's lexical score
 * dominate the fusion, so the lexical scores are normalised against the best one
 * in this result set. That makes the term half a *ranking* signal rather than a
 * magnitude — which is all it is being asked for.
 */
function normalise(scores: Map<string, number>): Map<string, number> {
	const best = Math.max(...scores.values(), 0)
	if (best <= 0) return new Map()
	return new Map([...scores].map(([id, score]) => [id, score / best]))
}

export const retrievalService = {
	async retrieve(options: RetrieveOptions): Promise<RetrievalOutcome> {
		const empty: RetrievalOutcome = { chunks: [], rerankUsage: null }

		const baseIds = [...new Set(options.knowledgeBaseIds)]
		if (baseIds.length === 0) return empty

		const bases = await Promise.all(
			baseIds.map(async (baseId) => {
				const base = await knowledgeRepository.findBase(options.workspaceId, baseId)
				if (!base) throw new NotFoundError("Knowledge base")
				return base
			}),
		)

		const primary = bases[0]
		if (!primary) return empty

		// Vectors from two embedding models are not comparable. Searching a mixed
		// set would not degrade the ranking, it would produce one — so this is a
		// refusal, not a warning.
		const mismatched = bases.find(
			(base) =>
				base.embeddingProvider !== primary.embeddingProvider ||
				base.embeddingModel !== primary.embeddingModel,
		)
		if (mismatched) {
			throw new ValidationError(
				`"${mismatched.name}" is embedded with ${mismatched.embeddingProvider}/${mismatched.embeddingModel} and "${primary.name}" with ${primary.embeddingProvider}/${primary.embeddingModel}. Passages from two embedding models cannot be ranked against each other.`,
			)
		}

		if (bases.every((base) => base.chunkCount === 0)) return empty

		const mode = options.mode ?? "hybrid"
		const topK = options.topK ?? Number(primary.topK) ?? DEFAULT_TOP_K
		const threshold =
			options.similarityThreshold ??
			Number(primary.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD)
		const vectorWeight =
			mode === "vector"
				? 1
				: mode === "keyword"
					? 0
					: (options.vectorWeight ?? Number(primary.vectorWeight ?? DEFAULT_VECTOR_WEIGHT))
		const termWeight = 1 - vectorWeight

		const rerankSelection =
			options.rerank === undefined
				? primary.rerankProvider && primary.rerankModel
					? { provider: primary.rerankProvider, model: primary.rerankModel }
					: null
				: options.rerank

		// A reranker reorders whatever it is given, so the candidate pool has to be
		// wide enough for it to have something to do.
		const candidateLimit = Math.max(MIN_CANDIDATES, topK * CANDIDATE_MULTIPLIER)

		const target = await resolveEmbeddingModel(
			primary.embeddingProvider,
			primary.embeddingModel,
		)

		// Both halves in parallel: they hit different stores and neither depends on
		// the other's result. A mode that switches one off skips its call rather
		// than weighting the result to zero — the point of a mode is to not pay for
		// the half it does not use.
		const [dense, lexical] = await Promise.all([
			vectorWeight > 0
				? (async () => {
						const embedded = await embedTexts(target, [options.question])
						const vector = embedded.vectors[0]
						if (!vector) return []
						// One search per base: Qdrant filters on a single
						// `knowledgeBaseId` value, and the alternative — a wider filter
						// plus a post-hoc drop — would silently return fewer than
						// `candidateLimit` usable hits.
						const perBase = await Promise.all(
							baseIds.map((baseId) =>
								searchChunks(
									target.dimensions,
									vector,
									{
										workspaceId: options.workspaceId,
										knowledgeBaseId: baseId,
										documentIds: options.documentIds,
									},
									candidateLimit,
								),
							),
						)
						return perBase.flat()
					})()
				: Promise.resolve([]),
			termWeight > 0
				? knowledgeRepository.searchChunksByText(
						options.workspaceId,
						baseIds,
						[options.question, ...(options.keywords ?? [])].join(" "),
						candidateLimit,
						options.documentIds,
					)
				: Promise.resolve([]),
		])

		const vectorScores = new Map(dense.map((hit) => [hit.chunkId, hit.score]))
		const termScores = normalise(new Map(lexical.map((hit) => [hit.id, Number(hit.score)])))

		const fused = new Map<string, { score: number; vector: number; term: number }>()
		for (const chunkId of new Set([...vectorScores.keys(), ...termScores.keys()])) {
			const vectorScore = vectorScores.get(chunkId) ?? 0
			const termScore = termScores.get(chunkId) ?? 0
			fused.set(chunkId, {
				score: vectorScore * vectorWeight + termScore * termWeight,
				vector: vectorScore,
				term: termScore,
			})
		}

		const ranked = [...fused.entries()]
			.filter(([, scores]) => scores.score >= threshold)
			.sort((a, b) => b[1].score - a[1].score)
			// Keep the whole candidate pool when a reranker will reorder it; the
			// point of reranking is that fusion's order is not the final one.
			.slice(0, rerankSelection ? candidateLimit : topK)

		if (ranked.length === 0) {
			log.debug("retrieval.empty", {
				workspaceId: options.workspaceId,
				knowledgeBaseIds: baseIds,
				mode,
				candidates: fused.size,
				threshold,
			})
			return empty
		}

		// The text lives only in Postgres — Qdrant holds vectors and ids — so the
		// passages are fetched once, for the winners, rather than carried through
		// the ranking.
		const rows = await knowledgeRepository.findChunksByIds(
			options.workspaceId,
			ranked.map(([chunkId]) => chunkId),
		)
		const byId = new Map(rows.map((row) => [row.id, row]))

		const candidates = ranked.flatMap<RetrievedChunk>(([chunkId, scores]) => {
			const row = byId.get(chunkId)
			// A vector whose chunk row is gone: the document was deleted between the
			// search and this read. Dropping it is right — there is nothing to cite.
			if (!row) return []
			return [
				{
					chunkId,
					documentId: row.documentId,
					documentName: row.documentName,
					knowledgeBaseId: row.knowledgeBaseId,
					ordinal: row.ordinal,
					content: row.content,
					kind: row.kind,
					level: row.level,
					fromPage: row.fromPage,
					toPage: row.toPage,
					score: scores.score,
					vectorScore: scores.vector,
					termScore: scores.term,
					rerankScore: null,
				},
			]
		})

		if (!rerankSelection) return { chunks: candidates.slice(0, topK), rerankUsage: null }

		return this.applyRerank(rerankSelection, options.question, candidates, topK)
	},

	/**
	 * Second stage. A reranker failure is not a retrieval failure: fusion already
	 * produced a usable order, so a provider outage degrades the answer rather
	 * than refusing it, and the reason goes to the log.
	 */
	async applyRerank(
		selection: { provider: string; model: string },
		question: string,
		candidates: RetrievedChunk[],
		topK: number,
	): Promise<RetrievalOutcome> {
		try {
			const target = await resolveRerankModel(selection.provider, selection.model)
			const outcome = await rerankPassages(
				target,
				question,
				candidates.map((entry) => entry.content),
				topK,
			)

			const reordered = outcome.order.flatMap<RetrievedChunk>((entry) => {
				const candidate = candidates[entry.index]
				if (!candidate) return []
				return [{ ...candidate, score: entry.score, rerankScore: entry.score }]
			})

			return {
				chunks: (reordered.length > 0 ? reordered : candidates).slice(0, topK),
				rerankUsage: {
					provider: target.provider,
					model: target.model,
					tokens: outcome.tokens,
					estimated: outcome.estimated,
				},
			}
		} catch (error) {
			log.warn("retrieval.rerank_failed", {
				provider: selection.provider,
				model: selection.model,
				error: String(error),
			})
			return { chunks: candidates.slice(0, topK), rerankUsage: null }
		}
	},
}
