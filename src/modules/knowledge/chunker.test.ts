import { describe, expect, it } from "vitest"

import { chunkSections } from "./chunker"
import type { ExtractedSection } from "./extractor"

/**
 * The chunker decides what a passage *is*, and every failure it can have is
 * silent. A budget that drifts produces chunks the embedding model truncates,
 * so the tail of every passage is indexed as nothing. An overlap that stops
 * being emitted makes an answer straddling a boundary invisible to both sides.
 * A paragraph the splitter cannot break is either dropped or grows without
 * limit. None of that raises anything — it comes back as "the assistant could
 * not find it in the document", which reads like a retrieval problem and gets
 * debugged as one.
 *
 * `chunkSections` is pure and takes no I/O, so there is no reason any of it
 * should have been unproven.
 *
 * Note on what is deliberately not asserted here: `Chunk.position` is wrong
 * whenever the overlap is non-zero — it stays on the first section's position
 * for the whole document — and it is also never written to the `chunk` table.
 * Asserting today's value would freeze the defect; see the report that came
 * with these tests.
 */

const section = (text: string, position = "page 1", page?: number): ExtractedSection =>
	page === undefined ? { text, position } : { text, position, page }

/** ~14 tokens each, and each one carries its own number so it can be traced. */
const sentence = (n: number) =>
	`Sentence number ${n} carries enough words to be worth measuring here. `

const prose = (count: number) =>
	Array.from({ length: count }, (_, index) => sentence(index)).join("")

describe("chunkSections", () => {
	it("closes a chunk near the token budget rather than at the first delimiter", () => {
		const chunks = chunkSections([section(prose(40))], {
			tokenSize: 128,
			overlapPercent: 15,
		})

		// A chunk of one sentence retrieves badly, and a chunk of twenty overflows
		// the budget it was sized for. Everything lands between the close point
		// (85% of the budget) and the budget itself.
		expect(chunks.length).toBeGreaterThan(1)
		for (const chunk of chunks) {
			expect(chunk.tokenCount).toBeLessThanOrEqual(128)
		}
		expect(chunks.filter((chunk) => chunk.tokenCount > 100).length).toBeGreaterThan(1)
	})

	it("loses no sentence of the document between the chunks", () => {
		const chunks = chunkSections([section(prose(40))], {
			tokenSize: 128,
			overlapPercent: 15,
		})

		for (let index = 0; index < 40; index += 1) {
			expect(chunks.some((chunk) => chunk.content.includes(`Sentence number ${index} `))).toBe(
				true,
			)
		}
	})

	it("starts each chunk with the tail of the one before it", () => {
		const chunks = chunkSections([section(prose(40))], {
			tokenSize: 128,
			overlapPercent: 15,
		})

		// The property that matters is that the overlap is really there: the first
		// characters of a chunk have to be findable at the end of its predecessor.
		for (let index = 1; index < chunks.length; index += 1) {
			const head = chunks[index]!.content.slice(0, 40)
			expect(chunks[index - 1]!.content.endsWith(head.slice(0, 20))).toBe(false)
			expect(chunks[index - 1]!.content).toContain(head)
		}
	})

	it("repeats nothing when the knowledge base asks for no overlap", () => {
		const chunks = chunkSections([section(prose(40))], {
			tokenSize: 128,
			overlapPercent: 0,
		})

		expect(chunks.length).toBeGreaterThan(1)
		for (let index = 1; index < chunks.length; index += 1) {
			const head = chunks[index]!.content.slice(0, 40)
			expect(chunks[index - 1]!.content).not.toContain(head)
		}
	})

	it("keeps a paragraph with no delimiter in it rather than dropping it", () => {
		// Nothing in DEFAULT_DELIMITERS appears in this text, so the splitter
		// returns it whole and the merge loop has one indivisible piece to place.
		const solid = "x".repeat(4_000)
		const chunks = chunkSections([section(solid)], { tokenSize: 128, overlapPercent: 15 })

		// It overshoots the budget, which is the documented trade: capping at one
		// oversized piece is better than cutting a word in half, and better than
		// letting the buffer grow across several of them.
		expect(chunks[0]?.content).toBe(solid)
	})

	it("keeps a single sentence longer than the whole budget", () => {
		const oversized = `${"word ".repeat(400)}THE-END. `
		const chunks = chunkSections([section(oversized + prose(10))], {
			tokenSize: 128,
			overlapPercent: 15,
		})

		expect(chunks.some((chunk) => chunk.content.includes("THE-END."))).toBe(true)
		expect(chunks.some((chunk) => chunk.content.includes("Sentence number 9 "))).toBe(true)
	})

	it("produces nothing from a document with no text in it", () => {
		expect(chunkSections([], { tokenSize: 512, overlapPercent: 15 })).toEqual([])
		expect(chunkSections([section("")], { tokenSize: 512, overlapPercent: 15 })).toEqual([])
		expect(
			chunkSections([section("   \n\n  \n ")], { tokenSize: 512, overlapPercent: 15 }),
		).toEqual([])
	})

	it("drops a chunk too short to be worth putting in a vector index", () => {
		// RAGFlow's `tnum < 8` guard. A three-token chunk matches everything
		// weakly and carries no context, so it is noise in the index rather than a
		// small win.
		expect(chunkSections([section("Hi there.")], { tokenSize: 512, overlapPercent: 15 })).toEqual(
			[],
		)
		expect(
			chunkSections([section("This sentence is long enough to survive the guard.")], {
				tokenSize: 512,
				overlapPercent: 15,
			}),
		).toHaveLength(1)
	})

	it("splits on a delimiter set the knowledge base overrides", () => {
		const text = Array.from({ length: 30 }, (_, index) => `record ${index} of the export`).join(
			"|",
		)
		const chunks = chunkSections([section(text)], {
			tokenSize: 32,
			overlapPercent: 0,
			delimiters: ["|"],
		})

		expect(chunks.length).toBeGreaterThan(1)
		// The delimiter stays on the left piece, so a record is never orphaned from
		// the separator that ended it.
		expect(chunks[0]?.content).toContain("record 0 of the export|")
	})

	it("prefixes every chunk with the heading path it was given", () => {
		const chunks = chunkSections([section(prose(40))], {
			tokenSize: 128,
			overlapPercent: 15,
			prefix: "Handbook › Leave",
		})

		expect(chunks.length).toBeGreaterThan(1)
		for (const chunk of chunks) {
			expect(chunk.content.startsWith("Handbook › Leave\n\n")).toBe(true)
			// Once, not twice: the prefix is re-added on every flush, so carrying it
			// into the overlap would repeat the heading inside a single chunk.
			expect(chunk.content.split("Handbook › Leave")).toHaveLength(2)
		}
	})

	it("counts the prefix against the budget, because the embedding model will", () => {
		const withoutPrefix = chunkSections([section(prose(40))], {
			tokenSize: 128,
			overlapPercent: 15,
		})
		const withPrefix = chunkSections([section(prose(40))], {
			tokenSize: 128,
			overlapPercent: 15,
			prefix: "Handbook › Leave",
		})

		expect(withPrefix[0]!.tokenCount).toBeGreaterThan(withoutPrefix[0]!.tokenCount)
	})

	it("records the pages a chunk was built from", () => {
		const chunks = chunkSections(
			[
				section(prose(20), "page 1", 1),
				section(prose(20), "page 2", 2),
				section(prose(20), "page 3", 3),
			],
			{ tokenSize: 256, overlapPercent: 0 },
		)

		expect(chunks[0]?.fromPage).toBe(1)
		expect(chunks[chunks.length - 1]?.toPage).toBe(3)
		for (const chunk of chunks) {
			expect(chunk.fromPage).not.toBeNull()
			expect(chunk.toPage!).toBeGreaterThanOrEqual(chunk.fromPage!)
		}
	})

	it("reports no page for a format that has none", () => {
		const chunks = chunkSections([section(prose(20), "block 1")], {
			tokenSize: 128,
			overlapPercent: 15,
		})

		expect(chunks.every((chunk) => chunk.fromPage === null && chunk.toPage === null)).toBe(true)
	})

	it("refuses a token budget too small to hold a sentence", () => {
		// Floored at 32. A budget of 1 would close a chunk on every piece and
		// produce a document of single sentences, all of which the length guard
		// would then drop — an empty knowledge base from a valid setting.
		const tiny = chunkSections([section(prose(40))], { tokenSize: 1, overlapPercent: 15 })
		const floor = chunkSections([section(prose(40))], { tokenSize: 32, overlapPercent: 15 })

		expect(tiny.length).toBeGreaterThan(0)
		expect(tiny).toEqual(floor)
	})

	it("caps an overlap that would leave no room for new text", () => {
		// Clamped to 90. At 100% every chunk would be its predecessor's tail and
		// the chunker would never advance through the document.
		const chunks = chunkSections([section(prose(40))], { tokenSize: 128, overlapPercent: 100 })

		expect(chunks.some((chunk) => chunk.content.includes("Sentence number 39 "))).toBe(true)
	})
})
