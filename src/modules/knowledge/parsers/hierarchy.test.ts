import { describe, expect, it } from "vitest"

import {
	anyOf,
	articleHeading,
	breadcrumb,
	chapterHeading,
	markdownHeading,
	numberedHeading,
	paperHeading,
	segment,
} from "./hierarchy"
import type { ExtractedSection } from "../extractor"
import type { HeadingRule } from "./hierarchy"

/**
 * Four of the ten chunking strategies — paper, book, manual and legal — are the
 * same function with a different idea of what a heading looks like. That makes
 * this file the single point where all four break: a rule that stops matching
 * turns its strategy into the general chunker without saying so, and a rule that
 * matches too eagerly cuts a paragraph in half at "1. " and prefixes the
 * remainder with a heading that is really a sentence. Either way the upload
 * succeeds, the document indexes, and the only symptom is worse answers.
 *
 * The engine is worth pinning down separately from the rules, because the
 * breadcrumb is what a chunk from the middle of a manual uses to say which
 * procedure it belongs to.
 */

const section = (text: string, position = "page 1"): ExtractedSection => ({ text, position })

const paths = (sections: ExtractedSection[], rule: HeadingRule) =>
	segment(sections, rule).map((entry) => breadcrumb(entry.path))

describe("segment", () => {
	const handbook = section(
		[
			"Preamble before any heading.",
			"# Handbook",
			"Introduction line.",
			"## Leave",
			"Leave body.",
			"### Sick leave",
			"Sick body.",
			"## Pay",
			"Pay body.",
		].join("\n"),
	)

	it("keeps the heading path above every piece of body text", () => {
		expect(paths([handbook], markdownHeading)).toEqual([
			"",
			"# Handbook",
			"# Handbook › ## Leave",
			"# Handbook › ## Leave › ### Sick leave",
			"# Handbook › ## Pay",
		])
	})

	it("replaces the path from a heading's own depth down and keeps what is above it", () => {
		// "## Pay" arrives while the path is three deep. It has to drop the sick
		// leave level and keep the handbook, or a chunk about pay is filed under
		// sick leave.
		const segments = segment([handbook], markdownHeading)
		expect(segments[segments.length - 1]?.path).toEqual(["# Handbook", "## Pay"])
	})

	it("carries text that precedes the first heading under an empty path", () => {
		const segments = segment([handbook], markdownHeading)
		expect(segments[0]?.path).toEqual([])
		expect(segments[0]?.sections[0]?.text).toBe("Preamble before any heading.")
	})

	it("reads headings inside one section, because a PDF page is one section", () => {
		// The extractor emits a whole page as a single ExtractedSection, so a
		// section-by-section walk would find at most one heading per page and the
		// four structured strategies would see almost no structure at all.
		const segments = segment([handbook], markdownHeading)
		expect(segments.length).toBe(5)
	})

	it("slots a heading that skipped a level at its own depth", () => {
		// A document that jumps from H1 to H3 has skipped a level, which is not a
		// reason to lose the H1 above it.
		expect(paths([section(["# A", "body a", "### C", "body c"].join("\n"))], markdownHeading))
			.toEqual(["# A", "# A › ### C"])
	})

	it("carries a heading from one section into the next", () => {
		// A chapter that runs over a page break is one segment, and each page keeps
		// its own position so a citation still names the right one.
		const segments = segment(
			[
				section("# Chapter one\nfirst page body", "page 1"),
				section("second page body", "page 2"),
			],
			markdownHeading,
		)

		expect(segments).toHaveLength(1)
		expect(segments[0]?.path).toEqual(["# Chapter one"])
		expect(segments[0]?.sections.map((entry) => [entry.text, entry.position])).toEqual([
			["first page body", "page 1"],
			["second page body", "page 2"],
		])
	})

	it("emits nothing for a heading with no body under it", () => {
		// A table-of-contents line or a part title. The strategies decide
		// separately whether the heading is worth keeping on its own.
		const segments = segment([section(["# A", "## B", "body b"].join("\n"))], markdownHeading)
		expect(segments).toHaveLength(1)
		expect(segments[0]?.path).toEqual(["# A", "## B"])
	})

	it("produces nothing at all from a document with no text", () => {
		expect(segment([], markdownHeading)).toEqual([])
		expect(segment([section("")], markdownHeading)).toEqual([])
		expect(segment([section("  \n \n ")], markdownHeading)).toEqual([])
	})

	it("returns one pathless segment when no heading matches anywhere", () => {
		// This is the signal the structured parsers fall back to the general
		// chunker on, so it has to stay one segment rather than zero.
		const segments = segment([section("Just prose.\nMore prose.")], markdownHeading)
		expect(segments).toHaveLength(1)
		expect(segments[0]?.path).toEqual([])
	})

	it("trims each line and drops the blank ones", () => {
		const segments = segment([section("#  Title  \n\n   body one   \n\n  body two")], markdownHeading)
		expect(segments[0]?.path).toEqual(["#  Title"])
		expect(segments[0]?.sections[0]?.text).toBe("body one\nbody two")
	})
})

describe("markdownHeading", () => {
	it("reads depth from the number of hashes", () => {
		expect(markdownHeading.depth("# One")).toBe(1)
		expect(markdownHeading.depth("### Three")).toBe(3)
		expect(markdownHeading.depth("###### Six")).toBe(6)
	})

	it("ignores a run of hashes deeper than markdown allows", () => {
		expect(markdownHeading.depth("####### Seven")).toBeNull()
	})

	it("needs whitespace and text after the hashes", () => {
		expect(markdownHeading.depth("#NoSpace")).toBeNull()
		expect(markdownHeading.depth("#")).toBeNull()
		expect(markdownHeading.depth("a # not a heading")).toBeNull()
	})
})

describe("numberedHeading", () => {
	it("reads depth from how many components the number has", () => {
		expect(numberedHeading.depth("1. Scope")).toBe(1)
		expect(numberedHeading.depth("1.2 Definitions")).toBe(2)
		expect(numberedHeading.depth("1.2.3 Sub-clause")).toBe(3)
	})

	it("stops counting at six levels", () => {
		expect(numberedHeading.depth("1.2.3.4.5.6.7.8 Very deep")).toBe(6)
	})

	it("takes a closing bracket as well as a full stop", () => {
		expect(numberedHeading.depth("4) Installation")).toBe(1)
	})

	it("does not read a year at the start of a sentence as a section", () => {
		expect(numberedHeading.depth("2024. A")).toBeNull()
	})

	it("does not read a long numbered paragraph as a heading", () => {
		// A numbered list item runs on; a heading does not. This is the guard that
		// keeps an ordered list from becoming twenty one-line sections.
		expect(numberedHeading.depth(`1. ${"a".repeat(140)}`)).toBeNull()
	})

	it("does not read a line that ends mid-clause as a heading", () => {
		expect(numberedHeading.depth("1. The parties agree that,")).toBeNull()
	})
})

describe("chapterHeading", () => {
	it("matches the words a chapter is announced with, in either language", () => {
		expect(chapterHeading.depth("Chapter 4")).toBe(1)
		expect(chapterHeading.depth("PART II")).toBe(1)
		expect(chapterHeading.depth("Chương 2")).toBe(1)
		expect(chapterHeading.depth("Phần mở đầu")).toBe(1)
	})

	it("is a top-level heading whatever the number says", () => {
		expect(chapterHeading.depth("Chapter 12")).toBe(1)
	})

	it("ignores the word in the middle of a sentence", () => {
		expect(chapterHeading.depth("See chapter 4 for details")).toBeNull()
	})

	it("is kept off a sentence that opens with the word only by its length", () => {
		// A short line beginning with "Section" is read as one, and nothing else
		// distinguishes it. The 120-character guard is the whole defence, which is
		// worth knowing before anybody shortens it.
		expect(chapterHeading.depth("Section 3 does not apply.")).toBe(1)
		expect(
			chapterHeading.depth(`Section 3 does not apply ${"to this arrangement ".repeat(8)}`),
		).toBeNull()
	})
})

describe("articleHeading", () => {
	it("matches an article in the three spellings a statute uses", () => {
		expect(articleHeading.depth("Điều 5. Quyền của người lao động")).toBe(2)
		expect(articleHeading.depth("Article 12")).toBe(2)
		expect(articleHeading.depth("Art. 12")).toBe(2)
		expect(articleHeading.depth("第5条")).toBe(2)
	})

	it("keeps an article below the chapter that contains it", () => {
		// Depth 2 against a chapter's 1, so a breadcrumb reads
		// "Chapter II › Article 12" rather than replacing the chapter.
		expect(articleHeading.depth("Chapter II")).toBe(1)
		expect(
			paths(
				[
					section(
						["Chapter II", "General provisions.", "Article 12", "article body"].join("\n"),
					),
				],
				articleHeading,
			),
		).toEqual(["Chapter II", "Chapter II › Article 12"])
	})

	it("ignores an article referred to rather than opened", () => {
		expect(articleHeading.depth("as set out in Article 12")).toBeNull()
	})
})

describe("paperHeading", () => {
	it("matches the sections a paper conventionally has", () => {
		expect(paperHeading.depth("Abstract")).toBe(1)
		expect(paperHeading.depth("Related Work")).toBe(1)
		expect(paperHeading.depth("References")).toBe(1)
	})

	it("matches a conventional section that carries a number too", () => {
		// A preprint numbers its sections inconsistently, so the name is the
		// reliable signal and the number is stripped before matching.
		expect(paperHeading.depth("3. Methods")).toBe(1)
		expect(paperHeading.depth("4.1 Experiments")).toBe(1)
	})

	it("falls back to plain numbering for a section it has no name for", () => {
		expect(paperHeading.depth("5.2 Ablation on the encoder")).toBe(2)
	})

	it("ignores prose that begins with a section's name", () => {
		expect(paperHeading.depth(`Results ${"of the study ".repeat(12)}`)).toBeNull()
	})
})

describe("anyOf", () => {
	it("lets the first rule that claims a line decide its depth", () => {
		// Order is the whole configuration of the four strategies: `book` puts
		// chapters ahead of numbering so "Chapter 4" is depth 1 rather than being
		// missed, and `manual` puts numbering first for the same reason in reverse.
		const rule = anyOf(markdownHeading, chapterHeading, numberedHeading)
		expect(rule.depth("Chapter 4")).toBe(1)
		expect(rule.depth("1.2 Something")).toBe(2)
		expect(rule.depth("# Title")).toBe(1)
	})

	it("claims nothing when no rule does", () => {
		expect(anyOf(markdownHeading, chapterHeading).depth("ordinary prose")).toBeNull()
	})
})

describe("breadcrumb", () => {
	it("joins the path the way a chunk prefix shows it", () => {
		expect(breadcrumb(["Chapter II", "Article 12"])).toBe("Chapter II › Article 12")
	})

	it("is empty for text that had no heading above it", () => {
		expect(breadcrumb([])).toBe("")
	})
})
