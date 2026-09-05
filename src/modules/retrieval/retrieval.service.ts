import { embedTexts, resolveEmbeddingModel } from "../../ai/embed"
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
 * stack. The fusion, the weight and the threshold below are RAGFlow's.
 *
 * The reranker model is likewise absent. RAGFlow's is optional and off by
 * default; adding one is a provider call per candidate, and it belongs after
 * there is evidence that fusion alone is not good enough.
 */
export const DEFAULT_TOP_K = 6

/**
 * How much of the score comes from the vector. RAGFlow's `retrieval` defaults to
 * 0.3 for the vector and 0.7 for the terms; its chat path passes 0.7 the other
 * way. 0.7 vector is the right default for a question-answering product — the
 * questions are natural language, and lexical matching is the tiebreaker rather
 * than the driver.
 */
const VECTOR_WEIGHT = 0.7
const TERM_WEIGHT = 1 - VECTOR_WEIGHT

/** Below this a passage is noise. RAGFlow's `similarity_threshold` default. */
const DEFAULT_SIMILARITY_THRESHOLD = 0.2

/**
 * Candidates pulled from each half before fusion. Wider than `topK` on purpose:
 * a passage ranked 20th by vector and 2nd by terms should be able to win, and it
 * cannot if it was never a candidate.
 */
const CANDIDATE_MULTIPLIER = 5
const MIN_CANDIDATES = 30

export interface RetrievedChunk {
	chunkId: string
	documentId: string
	documentName: string
	ordinal: number
	content: string
	score: number
	vectorScore: number
	termScore: number
}

export interface RetrieveOptions {
	workspaceId: string
	knowledgeBaseId: string
	question: string
	topK?: number
	similarityThreshold?: number
	/** Narrows retrieval to specific documents. Empty or absent means the whole base. */
	documentIds?: string[]
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
	async retrieve(options: RetrieveOptions): Promise<RetrievedChunk[]> {
		const base = await knowledgeRepository.findBase(
			options.workspaceId,
			options.knowledgeBaseId,
		)
		if (!base) throw new NotFoundError("Knowledge base")
		if (base.chunkCount === 0) return []

		const topK = options.topK ?? DEFAULT_TOP_K
		const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD
		const candidateLimit = Math.max(MIN_CANDIDATES, topK * CANDIDATE_MULTIPLIER)

		const target = await resolveEmbeddingModel(base.embeddingProvider, base.embeddingModel)
		const embedded = await embedTexts(target, [options.question])
		const vector = embedded.vectors[0]
		if (!vector) return []

		// Both halves in parallel: they hit different stores and neither depends
		// on the other's result.
		const [dense, lexical] = await Promise.all([
			searchChunks(
				target.dimensions,
				vector,
				{
					workspaceId: options.workspaceId,
					knowledgeBaseId: options.knowledgeBaseId,
					documentIds: options.documentIds,
				},
				candidateLimit,
			),
			knowledgeRepository.searchChunksByText(
				options.workspaceId,
				options.knowledgeBaseId,
				options.question,
				candidateLimit,
			),
		])

		const vectorScores = new Map(dense.map((hit) => [hit.chunkId, hit.score]))
		const termScores = normalise(
			new Map(lexical.map((hit) => [hit.id, Number(hit.score)])),
		)

		const fused = new Map<string, { score: number; vector: number; term: number }>()
		for (const chunkId of new Set([...vectorScores.keys(), ...termScores.keys()])) {
			const vectorScore = vectorScores.get(chunkId) ?? 0
			const termScore = termScores.get(chunkId) ?? 0
			fused.set(chunkId, {
				score: vectorScore * VECTOR_WEIGHT + termScore * TERM_WEIGHT,
				vector: vectorScore,
				term: termScore,
			})
		}

		const ranked = [...fused.entries()]
			.filter(([, scores]) => scores.score >= threshold)
			.sort((a, b) => b[1].score - a[1].score)
			.slice(0, topK)

		if (ranked.length === 0) {
			log.debug("retrieval.empty", {
				workspaceId: options.workspaceId,
				knowledgeBaseId: options.knowledgeBaseId,
				candidates: fused.size,
				threshold,
			})
			return []
		}

		// The text lives only in Postgres — Qdrant holds vectors and ids — so the
		// passages are fetched once, for the winners, rather than carried through
		// the ranking.
		const rows = await knowledgeRepository.findChunksByIds(
			options.workspaceId,
			ranked.map(([chunkId]) => chunkId),
		)
		const byId = new Map(rows.map((row) => [row.id, row]))

		return ranked.flatMap(([chunkId, scores]) => {
			const row = byId.get(chunkId)
			// A vector whose chunk row is gone: the document was deleted between the
			// search and this read. Dropping it is right — there is nothing to cite.
			if (!row) return []
			return [
				{
					chunkId,
					documentId: row.documentId,
					documentName: row.documentName,
					ordinal: row.ordinal,
					content: row.content,
					score: scores.score,
					vectorScore: scores.vector,
					termScore: scores.term,
				},
			]
		})
	},
}
