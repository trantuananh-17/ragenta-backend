import type { ExtractedSection } from "../extractor"

/**
 * Heading-aware segmentation, shared by the four structured strategies.
 *
 * RAGFlow's `book`, `laws`, `manual` and `paper` parsers each walk their input
 * looking for the boundaries a reader would recognise — a chapter, an article, a
 * numbered procedure step, a paper's section — and keep the title with the text
 * under it. That is the whole value: a chunk lifted out of the middle of a
 * manual says nothing about which procedure it belongs to, and no amount of
 * overlap fixes that. Prefixing the heading path does.
 *
 * The four differ only in what counts as a heading, so that is the parameter
 * and this is one function rather than four near-copies. RAGFlow reaches the
 * same shape through DeepDoc's layout model, which reads font size and position
 * off a rendered page; without that, headings have to be recognised from the
 * text itself, and the rules below are what survives that constraint.
 */
export interface HeadingRule {
	/**
	 * The heading depth of a line, 1 being the outermost, or null when the line
	 * is body text. Depth is what builds the breadcrumb: a level-2 heading
	 * replaces everything from level 2 down and keeps level 1 above it.
	 */
	depth(line: string): number | null
}

export interface Segment {
	/** Outermost heading first. Empty for text that precedes any heading. */
	path: string[]
	sections: ExtractedSection[]
}

/** A heading is a short line. A paragraph starting with "1. " is not one. */
const MAX_HEADING_LENGTH = 120

function isPlausibleHeading(line: string): boolean {
	return line.length > 0 && line.length <= MAX_HEADING_LENGTH && !line.endsWith(",")
}

/** `# H1` … `###### H6`. The only unambiguous heading syntax in this set. */
export const markdownHeading: HeadingRule = {
	depth(line) {
		const match = /^(#{1,6})\s+(\S.*)$/.exec(line)
		return match?.[1] ? match[1].length : null
	},
}

/**
 * `1.`, `1.2`, `1.2.3` — depth is how many components the number has. Common to
 * manuals, specifications and contracts, and the one numbering scheme that
 * carries its own depth rather than needing it inferred.
 */
export const numberedHeading: HeadingRule = {
	depth(line) {
		if (!isPlausibleHeading(line)) return null
		const match = /^(\d+(?:\.\d+)*)[.)]?\s+(\S.*)$/.exec(line)
		if (!match?.[1] || !match[2]) return null
		// "2024. A year in review" is a sentence, not a section 2024.
		if (match[2].length < 2) return null
		return Math.min(match[1].split(".").length, 6)
	},
}

export const chapterHeading: HeadingRule = {
	depth(line) {
		if (!isPlausibleHeading(line)) return null
		return /^(chapter|part|section|chương|phần|mục|第[一二三四五六七八九十百零\d]+[章部篇])\b/i.test(
			line,
		)
			? 1
			: null
	},
}

/**
 * A legal article. `Điều 5`, `Article 12`, `Art. 12`, `第5条` — the unit a legal
 * question is actually about, and the reason `laws` does not merge to a token
 * budget the way the others do.
 */
export const articleHeading: HeadingRule = {
	depth(line) {
		if (!isPlausibleHeading(line)) return null
		if (/^(điều|article|art\.)\s*\d+/i.test(line)) return 2
		if (/^第\s*[一二三四五六七八九十百零\d]+\s*条/.test(line)) return 2
		return chapterHeading.depth(line)
	},
}

/**
 * The sections an academic paper has, by name. Deliberately a fixed list: a
 * paper's structure is a convention, and matching the convention is more
 * reliable than inferring depth from a preprint's inconsistent numbering.
 */
const PAPER_SECTIONS =
	/^(abstract|introduction|background|related work|preliminaries|methodology|methods?|approach|model|experiments?|evaluation|results?|analysis|discussion|limitations|conclusions?|future work|acknowledg(e)?ments?|references|bibliography|appendix)\b/i

export const paperHeading: HeadingRule = {
	depth(line) {
		if (!isPlausibleHeading(line)) return null
		const stripped = line.replace(/^\d+(\.\d+)*[.)]?\s*/, "")
		if (PAPER_SECTIONS.test(stripped)) return 1
		return numberedHeading.depth(line)
	},
}

/** First rule that claims the line wins, so the more specific rule goes first. */
export function anyOf(...rules: HeadingRule[]): HeadingRule {
	return {
		depth(line) {
			for (const rule of rules) {
				const depth = rule.depth(line)
				if (depth !== null) return depth
			}
			return null
		},
	}
}

/**
 * Splits sections into heading-delimited segments, carrying the breadcrumb.
 *
 * Works line by line rather than section by section, because an extracted PDF
 * page is one section containing several headings, and a DOCX paragraph block
 * may be a heading followed by its own body.
 */
export function segment(sections: ExtractedSection[], rule: HeadingRule): Segment[] {
	const segments: Segment[] = []
	let path: string[] = []
	let buffer: ExtractedSection[] = []

	const flush = () => {
		if (buffer.length > 0) segments.push({ path: [...path], sections: buffer })
		buffer = []
	}

	for (const section of sections) {
		let pending: string[] = []

		const flushPending = () => {
			if (pending.length === 0) return
			buffer.push({
				text: pending.join("\n"),
				position: section.position,
				page: section.page,
			})
			pending = []
		}

		for (const line of section.text.split("\n")) {
			const trimmed = line.trim()
			const depth = trimmed.length > 0 ? rule.depth(trimmed) : null

			if (depth === null) {
				if (trimmed.length > 0) pending.push(trimmed)
				continue
			}

			flushPending()
			flush()
			// A heading three levels below the current path with nothing between
			// still slots in at its own depth; the gap is a document that skipped a
			// level, not a reason to lose the outer titles.
			path = [...path.slice(0, depth - 1), trimmed]
		}

		flushPending()
	}

	flush()
	return segments
}

/** The breadcrumb a chunk is prefixed with. Empty when the text had no heading. */
export function breadcrumb(path: string[]): string {
	return path.join(" › ")
}
