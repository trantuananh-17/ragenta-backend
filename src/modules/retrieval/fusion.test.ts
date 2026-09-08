import { describe, expect, it } from "vitest"

import { fuse } from "./fusion"

/**
 * Fusion decides which passages an answer is allowed to be built from, and it is
 * the one part of retrieval with no observable failure mode. A weight applied to
 * the wrong half, a normalisation that divides by the wrong number, a threshold
 * compared the wrong way round — none of them raise anything. They come back as
 * an assistant that answers from the second-best passage, or says it cannot find
 * something the knowledge base definitely contains, and the report is "the AI is
 * worse this week".
 *
 * The scores below are chosen so the arithmetic is checkable by hand: a cosine
 * similarity is already in [0, 1], and a `ts_rank_cd` is not, which is the whole
 * reason the lexical half is normalised before it is weighed.
 */

const wide = { similarityThreshold: 0, limit: 100 }

describe("fuse", () => {
	it("weighs the two halves against each other", () => {
		const [chunk] = fuse([{ chunkId: "a", score: 0.8 }], [{ id: "a", score: 0.5 }], {
			...wide,
			vectorWeight: 0.7,
		})

		// 0.8 × 0.7 + 1.0 × 0.3 — the lexical score normalises to 1 because it is
		// the best in its own set.
		expect(chunk?.score).toBeCloseTo(0.86, 10)
		expect(chunk?.vectorScore).toBe(0.8)
		expect(chunk?.termScore).toBe(1)
	})

	it("keeps a passage only one half found", () => {
		// The case hybrid retrieval exists for, in both directions: an error code
		// the vector misses, and a paraphrase the terms miss.
		const fused = fuse(
			[{ chunkId: "vector-only", score: 0.9 }],
			[{ id: "term-only", score: 4.2 }],
			{ ...wide, vectorWeight: 0.5 },
		)

		expect(fused.map((entry) => entry.chunkId).sort()).toEqual(["term-only", "vector-only"])
		expect(fused.find((entry) => entry.chunkId === "vector-only")?.termScore).toBe(0)
		expect(fused.find((entry) => entry.chunkId === "term-only")?.vectorScore).toBe(0)
	})

	it("normalises lexical scores against the best one in the result set", () => {
		// `ts_rank_cd` is unbounded. Added raw, one long document's score would
		// swamp every cosine similarity in the set and the vector weight would
		// stop meaning anything.
		const fused = fuse(
			[],
			[
				{ id: "a", score: 40 },
				{ id: "b", score: 10 },
			],
			{ ...wide, vectorWeight: 0 },
		)

		expect(fused.map((entry) => [entry.chunkId, entry.termScore])).toEqual([
			["a", 1],
			["b", 0.25],
		])
	})

	it("reads a lexical score that arrived from Postgres as a string", () => {
		const fused = fuse([], [{ id: "a", score: "0.0413" }], { ...wide, vectorWeight: 0 })
		expect(fused[0]?.termScore).toBe(1)
	})

	it("returns nothing when every lexical score is zero", () => {
		// A keyword-only search that matched no term. Dividing by the best score
		// would be a division by zero, and passing the raw zeroes through would
		// return the whole candidate pool ranked arbitrarily.
		expect(
			fuse(
				[],
				[
					{ id: "a", score: 0 },
					{ id: "b", score: 0 },
				],
				{ ...wide, vectorWeight: 0 },
			),
		).toEqual([])
	})

	it("orders the survivors best first", () => {
		const fused = fuse(
			[
				{ chunkId: "middle", score: 0.5 },
				{ chunkId: "best", score: 0.9 },
				{ chunkId: "worst", score: 0.1 },
			],
			[],
			{ ...wide, vectorWeight: 1 },
		)

		expect(fused.map((entry) => entry.chunkId)).toEqual(["best", "middle", "worst"])
	})

	it("drops a passage below the similarity threshold", () => {
		const fused = fuse(
			[
				{ chunkId: "good", score: 0.6 },
				{ chunkId: "noise", score: 0.05 },
			],
			[],
			{ vectorWeight: 1, similarityThreshold: 0.2, limit: 100 },
		)

		expect(fused.map((entry) => entry.chunkId)).toEqual(["good"])
	})

	it("keeps a passage sitting exactly on the threshold", () => {
		const fused = fuse([{ chunkId: "exact", score: 0.2 }], [], {
			vectorWeight: 1,
			similarityThreshold: 0.2,
			limit: 100,
		})

		expect(fused).toHaveLength(1)
	})

	it("cuts the result to the limit it was given", () => {
		// The limit is `topK` normally and the whole candidate pool when a reranker
		// will run, because reranking exists precisely to overturn this order.
		const dense = Array.from({ length: 30 }, (_, index) => ({
			chunkId: `chunk-${index}`,
			score: 1 - index / 100,
		}))

		expect(fuse(dense, [], { ...wide, vectorWeight: 1, limit: 6 })).toHaveLength(6)
		expect(fuse(dense, [], { ...wide, vectorWeight: 1, limit: 30 })).toHaveLength(30)
	})

	it("takes the highest scoring passages, not the first ones offered", () => {
		const fused = fuse(
			[
				{ chunkId: "weak", score: 0.2 },
				{ chunkId: "strong", score: 0.95 },
			],
			[],
			{ ...wide, vectorWeight: 1, limit: 1 },
		)

		expect(fused[0]?.chunkId).toBe("strong")
	})

	it("gives the lexical half no influence at a vector weight of 1", () => {
		// Vector-only mode. The service does not call the lexical half at all
		// there, so this is the belt to that brace: a passage the terms found
		// scores nothing on its own and the threshold takes it out.
		const dense = [{ chunkId: "a", score: 0.4 }]
		const lexical = [{ id: "b", score: 99 }]

		expect(fuse(dense, lexical, { ...wide, vectorWeight: 1 })).toEqual([
			{ chunkId: "a", score: 0.4, vectorScore: 0.4, termScore: 0 },
			{ chunkId: "b", score: 0, vectorScore: 0, termScore: 1 },
		])
		expect(
			fuse(dense, lexical, { vectorWeight: 1, similarityThreshold: 0.2, limit: 100 }).map(
				(entry) => entry.chunkId,
			),
		).toEqual(["a"])
	})

	it("gives the dense half no influence at a vector weight of 0", () => {
		const dense = [{ chunkId: "a", score: 0.99 }]
		const lexical = [{ id: "b", score: 3 }]

		expect(
			fuse(dense, lexical, { vectorWeight: 0, similarityThreshold: 0.2, limit: 100 }).map(
				(entry) => entry.chunkId,
			),
		).toEqual(["b"])
	})

	it("scores a passage both halves found on both of them", () => {
		const fused = fuse(
			[
				{ chunkId: "both", score: 0.6 },
				{ chunkId: "vector", score: 0.7 },
			],
			[
				{ id: "both", score: 8 },
				{ id: "term", score: 2 },
			],
			{ ...wide, vectorWeight: 0.5 },
		)

		// Agreement is what fusion rewards: 0.6 × 0.5 + 1 × 0.5 beats a stronger
		// vector score with no lexical support behind it.
		expect(fused[0]?.chunkId).toBe("both")
		expect(fused[0]?.score).toBeCloseTo(0.8, 10)
	})

	it("returns nothing when neither half found anything", () => {
		expect(fuse([], [], { ...wide, vectorWeight: 0.7 })).toEqual([])
	})
})
