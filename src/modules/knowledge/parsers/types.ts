import type { Buffer } from "node:buffer"

/**
 * Chunking strategies, as data.
 *
 * RAGFlow calls this `parser_id` and ships fifteen of them (`rag/app/*.py`); the
 * strategy is chosen per knowledge base and overridable per document, never
 * hardcoded. That indirection is the point of this module: "how is this file cut
 * into retrievable passages" is a property of the documents, not of the product.
 *
 * Ragenta implements the ten that need only text, and declares the three that
 * need a vision, speech or entity model without pretending they work. RAGFlow's
 * `knowledge_graph` and `tag` are absent for a different reason — they are not
 * chunking strategies at all, they are index-building passes over a base that
 * has already been chunked.
 */
export type ParserId =
	| "general"
	| "qa"
	| "table"
	| "one"
	| "paper"
	| "book"
	| "laws"
	| "manual"
	| "presentation"
	| "email"
	| "picture"
	| "audio"
	| "resume"

export const PARSER_IDS: ParserId[] = [
	"general",
	"qa",
	"table",
	"one",
	"paper",
	"book",
	"laws",
	"manual",
	"presentation",
	"email",
	"picture",
	"audio",
	"resume",
]

/**
 * What a chunk is, so retrieval and the UI can tell them apart.
 *
 * `qa` carries its question separately and is embedded question-first — the
 * thing a user's question matches is another question, not the answer's prose.
 * `summary` is a RAPTOR node: text no document contains, written by a model over
 * a cluster of real chunks.
 */
export type ChunkKind = "passage" | "qa" | "row" | "summary"

export interface ParsedChunk {
	content: string
	tokenCount: number
	/** Where it came from — a page, a heading path, a row number. Shown with a citation. */
	position: string
	kind: ChunkKind
	/** Set only for `qa`. The text that gets embedded, ahead of the answer. */
	question: string | null
	fromPage: number | null
	toPage: number | null
}

/**
 * Everything a parser is allowed to vary. Stored as `parser_config` JSONB on the
 * knowledge base, overridable per document, and resolved into this shape before
 * a parser ever sees it — so a parser reads plain numbers rather than deciding
 * what an absent field means.
 */
export interface ResolvedParserConfig {
	tokenSize: number
	overlapPercent: number
	/** Where a long passage may be cut. Empty falls back to the built-in set. */
	delimiters: string[]
	/** 1-based, inclusive page ranges to keep. Null means the whole document. */
	pages: Array<[number, number]> | null
	/** `table`: how many rows share one chunk. 1 is one chunk per row. */
	rowsPerChunk: number
	/** `qa`: column index of the question and of the answer, for CSV input. */
	qaColumns: { question: number; answer: number }
	/** How many keywords a model should extract per chunk. 0 disables it. */
	autoKeywords: number
	/** How many questions a model should write per chunk. 0 disables it. */
	autoQuestions: number
	raptor: {
		enabled: boolean
		/** Tree height above the leaves. RAGFlow's default is 3. */
		maxLevels: number
		/** Cosine similarity at which two chunks join a cluster. */
		threshold: number
		maxClusterSize: number
	}
}

export interface ParseInput {
	bytes: Buffer
	mimeType: string
	filename: string
	/** The format `resolveFormat` agreed on — `pdf`, `docx`, `csv`, … */
	format: string
	config: ResolvedParserConfig
}

export interface ParserDefinition {
	id: ParserId
	name: string
	description: string
	/**
	 * Formats this strategy can actually read. A file outside the list is
	 * refused at upload with the list in the message, rather than accepted and
	 * then chunked by a strategy that makes no sense for it.
	 */
	formats: readonly string[]
	/** Undefined = declared, not implemented. Upload refuses it and says why. */
	parse?: (input: ParseInput) => Promise<ParsedChunk[]>
	/** Why it is not implemented. Shown to the user. Set only when `parse` is absent. */
	unavailable?: string
}
