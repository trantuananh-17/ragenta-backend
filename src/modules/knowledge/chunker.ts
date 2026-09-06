import { estimateTokens } from "../../ai/tokens"
import type { ExtractedSection } from "./extractor"

/**
 * Sections to retrievable chunks.
 *
 * A port of RAGFlow's `naive_merge` (`rag/nlp/__init__.py`), which is the
 * chunker behind its default "General" parser, with its shape kept and its
 * Python-isms dropped:
 *
 *  1. Split anything longer than the budget at sentence delimiters, so a chunk
 *     never ends mid-clause.
 *  2. Merge the pieces back up until the budget is reached — a chunk of three
 *     sentences retrieves better than three chunks of one, because a single
 *     sentence rarely carries enough context to match a question.
 *  3. Prefix each new chunk with the tail of the previous one. That overlap is
 *     what stops an answer that straddles a boundary from being invisible to
 *     both chunks.
 *
 * The delimiter set is RAGFlow's, and the Chinese full stop, semicolon and
 * question mark are in it for the same reason they are there: a knowledge base
 * is not guaranteed to be in English, and splitting CJK text on `.` alone
 * produces one enormous chunk.
 */
export const DEFAULT_DELIMITERS = ["\n", "。", "；", "！", "？", ". ", "! ", "? ", "; "]

export interface Chunk {
	content: string
	tokenCount: number
	position: string
	/** 1-based, from the sections that fed this chunk. Null for pageless formats. */
	fromPage: number | null
	toPage: number | null
}

export interface ChunkOptions {
	/** Target size. RAGFlow's API default is 512. */
	tokenSize: number
	/** How much of the previous chunk to repeat, 0–99. */
	overlapPercent: number
	/** Overrides the built-in set. RAGFlow exposes this as `parser_config.delimiter`. */
	delimiters?: string[]
	/**
	 * Prepended to every chunk before it is measured and embedded — a heading
	 * path, a table header, a section title. It is what makes a chunk from the
	 * middle of a document still say what it is about, and it is why the
	 * hierarchical parsers can hand this function a flat section list.
	 */
	prefix?: string
}

/**
 * Splits one section at delimiters, keeping the delimiter on the left piece so
 * a sentence stays punctuated. Pieces are still merged afterwards, so a short
 * one is not a short chunk.
 */
function splitAtDelimiters(text: string, delimiters: string[]): string[] {
	let pieces = [text]

	for (const delimiter of delimiters) {
		pieces = pieces.flatMap((piece) => {
			const parts = piece.split(delimiter)
			return parts
				.map((part, index) => (index < parts.length - 1 ? part + delimiter : part))
				.filter((part) => part.length > 0)
		})
	}

	return pieces
}

export function chunkSections(
	sections: ExtractedSection[],
	options: ChunkOptions,
): Chunk[] {
	const tokenSize = Math.max(32, options.tokenSize)
	const overlapPercent = Math.min(Math.max(options.overlapPercent, 0), 90)
	// The point at which a chunk is "full enough" to close. Below the budget by
	// the overlap, so the prefix the next chunk inherits does not push it over.
	const closeAt = (tokenSize * (100 - overlapPercent)) / 100

	const delimiters =
		options.delimiters && options.delimiters.length > 0
			? options.delimiters
			: DEFAULT_DELIMITERS
	const prefix = options.prefix ? `${options.prefix.trim()}\n\n` : ""

	const chunks: Chunk[] = []
	let buffer = ""
	let bufferTokens = 0
	let bufferPosition = ""
	let fromPage: number | null = null
	let toPage: number | null = null
	let lastBody = ""

	const flush = () => {
		const body = buffer.trim()
		if (body.length > 0) {
			lastBody = body
			const content = prefix + body
			chunks.push({
				content,
				tokenCount: estimateTokens(content),
				position: bufferPosition,
				fromPage,
				toPage,
			})
		}
		buffer = ""
		bufferTokens = 0
		fromPage = null
		toPage = null
	}

	const overlapTail = () => {
		// The *body* of the previous chunk, never its prefix: the prefix is added
		// again on flush, and carrying it into the overlap would repeat a heading
		// twice inside one chunk.
		if (overlapPercent === 0) return ""
		const previous = lastBody
		// Taken by characters rather than tokens: the boundary only has to be
		// approximately right, and slicing a string is free where re-tokenising
		// every closed chunk would not be.
		return previous.slice(Math.floor((previous.length * (100 - overlapPercent)) / 100))
	}

	for (const section of sections) {
		for (const piece of splitAtDelimiters(section.text, delimiters)) {
			const pieceTokens = estimateTokens(piece)

			if (bufferTokens > 0 && bufferTokens >= closeAt) {
				flush()
				const tail = overlapTail()
				buffer = tail
				bufferTokens = estimateTokens(tail)
			}

			if (bufferTokens === 0) bufferPosition = section.position
			if (section.page !== undefined) {
				fromPage ??= section.page
				toPage = section.page
			}
			buffer += piece
			bufferTokens += pieceTokens

			// A single piece larger than the whole budget — an unbroken paragraph
			// with no delimiter in it. Closing here caps the chunk at roughly one
			// oversized piece rather than letting it grow without limit.
			if (bufferTokens >= tokenSize) {
				flush()
				const tail = overlapTail()
				buffer = tail
				bufferTokens = estimateTokens(tail)
			}
		}
	}

	flush()

	// A chunk of a few words is noise in a vector index: it matches broadly and
	// carries nothing. Dropping them is what RAGFlow's `tnum < 8` guard does.
	return chunks.filter((entry) => entry.tokenCount >= 8)
}
