import { chunkSections } from "../chunker"
import { extractSections } from "../extractor"
import type { ExtractedSection } from "../extractor"
import { applyPageFilter, parsedChunk, toParsedChunks } from "./shared"
import type { ParseInput, ParsedChunk } from "./types"

/**
 * RAGFlow's "General" (`naive`): split at sentence delimiters, merge back to a
 * token budget, overlap the boundary. The default, and the right one whenever
 * the document has no structure worth preserving.
 */
export async function parseGeneral(input: ParseInput): Promise<ParsedChunk[]> {
	const sections = applyPageFilter(
		await extractSections(input.bytes, input.mimeType, input.filename),
		input.config.pages,
	)

	return toParsedChunks(
		chunkSections(sections, {
			tokenSize: input.config.tokenSize,
			overlapPercent: input.config.overlapPercent,
			delimiters: input.config.delimiters,
		}),
	)
}

/**
 * RAGFlow's "One": the whole document as a single chunk, no splitting.
 *
 * For short documents where every part is context for every other — a one-page
 * policy, a product sheet, a meeting note. Splitting those makes retrieval
 * worse, because half the answer ends up in a passage that did not match.
 *
 * The embedding model's input limit is the real ceiling, and `embedTexts`
 * truncates to it. Rather than let that happen silently the document is cut
 * here, at a paragraph boundary, and the tail becomes a second chunk — a
 * "single chunk" strategy that quietly loses the end of a long file would be
 * worse than one that admits the file was long.
 */
const ONE_MAX_TOKENS = 7_000

export async function parseOne(input: ParseInput): Promise<ParsedChunk[]> {
	const sections = applyPageFilter(
		await extractSections(input.bytes, input.mimeType, input.filename),
		input.config.pages,
	)
	if (sections.length === 0) return []

	return toParsedChunks(
		chunkSections(sections, {
			tokenSize: ONE_MAX_TOKENS,
			overlapPercent: 0,
			delimiters: ["\n\n"],
		}),
	)
}

/**
 * RAGFlow's "Presentation": one chunk per slide.
 *
 * A slide is already the unit its author considered self-contained, so merging
 * two of them to fill a token budget joins two topics, and splitting one leaves
 * a bullet list without its title. Neither is what a slide deck wants.
 *
 * PPTX is not read — that needs an Office XML parser Ragenta does not ship — so
 * this is a PDF strategy, which is how decks are shared anyway.
 */
export async function parsePresentation(input: ParseInput): Promise<ParsedChunk[]> {
	const sections = applyPageFilter(
		await extractSections(input.bytes, input.mimeType, input.filename),
		input.config.pages,
	)

	return sections.flatMap((section: ExtractedSection) => {
		const text = section.text.trim()
		if (text.length === 0) return []
		const slide = section.page ?? null
		return [
			parsedChunk(text, section.position, "passage", { fromPage: slide, toPage: slide }),
		]
	})
}
