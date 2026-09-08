/**
 * The scoring half of hybrid retrieval.
 *
 * Split out of `retrieval.service.ts` because this is where the order of an
 * answer's sources is actually decided, and in the service it sits between an
 * embedding call, a Qdrant search and two Postgres reads — so none of it could
 * be exercised without all four running. Everything around it there is
 * orchestration: resolve the bases, fan out to both stores, hand the two score
 * lists to this, read the winning rows back. What is here is arithmetic over
 * two lists, and a change to the weight, the normalisation or the threshold
 * shows up as a failing test rather than as a quietly worse answer nobody can
 * attribute to anything.
 *
 * Which weight to use stays in the service: that is the search mode's decision,
 * and the mode also decides whether a half is called at all.
 */

/** A Qdrant hit. Cosine similarity, already in [0, 1]. */
export interface DenseHit {
	chunkId: string
	score: number
}

/** A Postgres hit. `ts_rank_cd`, unbounded, and delivered as a numeric string. */
export interface LexicalHit {
	id: string
	score: string | number
}

export interface FusedChunk {
	chunkId: string
	score: number
	vectorScore: number
	termScore: number
}

export interface FusionOptions {
	/** 1 uses the dense half alone, 0 the lexical half alone. */
	vectorWeight: number
	/** Below this a passage is noise and is not returned at all. */
	similarityThreshold: number
	/** How many survivors to keep. Wider than `topK` when a reranker will run. */
	limit: number
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

/**
 * Scores every passage either half found, on both halves, and returns the ones
 * above the threshold, best first.
 *
 * A passage only one half found keeps zero for the other rather than being
 * dropped: an error code that only term search matches, and a question phrased
 * in words the document never uses, are both the case hybrid retrieval exists
 * for.
 */
export function fuse(
	dense: readonly DenseHit[],
	lexical: readonly LexicalHit[],
	options: FusionOptions,
): FusedChunk[] {
	const termWeight = 1 - options.vectorWeight

	const vectorScores = new Map(dense.map((hit) => [hit.chunkId, hit.score]))
	const termScores = normalise(new Map(lexical.map((hit) => [hit.id, Number(hit.score)])))

	return [...new Set([...vectorScores.keys(), ...termScores.keys()])]
		.map((chunkId) => {
			const vectorScore = vectorScores.get(chunkId) ?? 0
			const termScore = termScores.get(chunkId) ?? 0
			return {
				chunkId,
				score: vectorScore * options.vectorWeight + termScore * termWeight,
				vectorScore,
				termScore,
			}
		})
		.filter((entry) => entry.score >= options.similarityThreshold)
		.sort((a, b) => b.score - a.score)
		.slice(0, options.limit)
}
