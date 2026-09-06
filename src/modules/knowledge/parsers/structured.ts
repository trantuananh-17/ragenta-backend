import { chunkSections } from "../chunker"
import { extractSections } from "../extractor"
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
import type { HeadingRule } from "./hierarchy"
import { MIN_CHUNK_TOKENS, applyPageFilter, parsedChunk, toParsedChunks } from "./shared"
import type { ParseInput, ParsedChunk } from "./types"

/**
 * The four heading-aware strategies. They differ in one thing — what a heading
 * looks like — and in whether a section may be merged with its neighbours.
 *
 * `laws` is the exception that earns its own flag. A legal question is about an
 * article, and an article is the answer's natural boundary whether it is two
 * lines or two pages. Merging two articles to fill a token budget produces a
 * passage that cites two provisions and belongs to neither.
 */
interface StructuredStrategy {
	rule: HeadingRule
	/** False keeps one segment as one chunk, splitting only when it is too large. */
	merge: boolean
}

const STRATEGIES = {
	paper: { rule: anyOf(markdownHeading, paperHeading), merge: true },
	book: { rule: anyOf(markdownHeading, chapterHeading, numberedHeading), merge: true },
	manual: { rule: anyOf(markdownHeading, numberedHeading, chapterHeading), merge: true },
	laws: { rule: anyOf(markdownHeading, articleHeading), merge: false },
} satisfies Record<string, StructuredStrategy>

export type StructuredParserId = keyof typeof STRATEGIES

/**
 * An unsplit segment is capped anyway. An article of forty pages is not a
 * retrievable passage, whatever the law says about it being one provision.
 */
const UNMERGED_CEILING_MULTIPLIER = 3

export async function parseStructured(
	id: StructuredParserId,
	input: ParseInput,
): Promise<ParsedChunk[]> {
	const strategy = STRATEGIES[id]
	const sections = applyPageFilter(
		await extractSections(input.bytes, input.mimeType, input.filename),
		input.config.pages,
	)

	const segments = segment(sections, strategy.rule)

	// No heading matched anywhere: this is a document the strategy cannot see
	// structure in. Falling back to the general chunker is better than emitting
	// one chunk per document, and the user finds out from the chunk list rather
	// than from an answer that cites nothing useful.
	if (segments.length <= 1) {
		return toParsedChunks(
			chunkSections(sections, {
				tokenSize: input.config.tokenSize,
				overlapPercent: input.config.overlapPercent,
				delimiters: input.config.delimiters,
			}),
		)
	}

	return segments.flatMap((entry) => {
		const prefix = breadcrumb(entry.path)
		const tokenSize = strategy.merge
			? input.config.tokenSize
			: input.config.tokenSize * UNMERGED_CEILING_MULTIPLIER

		const chunks = chunkSections(entry.sections, {
			tokenSize,
			// An unmerged segment has no boundary to bridge — each chunk is a whole
			// provision — so overlap would only repeat text.
			overlapPercent: strategy.merge ? input.config.overlapPercent : 0,
			delimiters: input.config.delimiters,
			prefix,
		})

		// A heading with nothing under it — a table of contents entry, a part
		// title. Worth keeping only if the heading itself carries meaning.
		if (chunks.length === 0 && prefix.length > 0) {
			const heading = entry.path[entry.path.length - 1] ?? ""
			return heading.length > 0 ? [parsedChunk(prefix, heading, "passage")] : []
		}

		return toParsedChunks(chunks).filter(
			(chunk) => chunk.tokenCount >= MIN_CHUNK_TOKENS,
		)
	})
}
