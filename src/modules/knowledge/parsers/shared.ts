import { estimateTokens } from "../../../ai/tokens"
import type { Chunk } from "../chunker"
import type { ExtractedSection } from "../extractor"
import type { ChunkKind, ParsedChunk, ResolvedParserConfig } from "./types"

/**
 * Keeps only the pages a knowledge base asked for. RAGFlow's
 * `parser_config.pages` — the way to index chapter 4 of a 600-page manual
 * without splitting the PDF by hand.
 */
export function applyPageFilter(
	sections: ExtractedSection[],
	pages: ResolvedParserConfig["pages"],
): ExtractedSection[] {
	if (!pages || pages.length === 0) return sections
	return sections.filter((section) => {
		if (section.page === undefined) return true
		return pages.some(([from, to]) => section.page! >= from && section.page! <= to)
	})
}

export function toParsedChunks(chunks: Chunk[], kind: ChunkKind = "passage"): ParsedChunk[] {
	return chunks.map((entry) => ({
		content: entry.content,
		tokenCount: entry.tokenCount,
		position: entry.position,
		kind,
		question: null,
		fromPage: entry.fromPage,
		toPage: entry.toPage,
	}))
}

export function parsedChunk(
	content: string,
	position: string,
	kind: ChunkKind,
	extra: Partial<Pick<ParsedChunk, "question" | "fromPage" | "toPage">> = {},
): ParsedChunk {
	return {
		content,
		tokenCount: estimateTokens(content),
		position,
		kind,
		question: extra.question ?? null,
		fromPage: extra.fromPage ?? null,
		toPage: extra.toPage ?? null,
	}
}

/** Below this a chunk is noise in a vector index. RAGFlow's `tnum < 8` guard. */
export const MIN_CHUNK_TOKENS = 8
