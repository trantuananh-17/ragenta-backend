import { z } from "zod"

import { ValidationError } from "../../../shared/errors"
import { parseEmail } from "./email"
import { parseGeneral, parseOne, parsePresentation } from "./general"
import { parseStructured } from "./structured"
import { parseQa, parseTable } from "./tabular"
import type { ParseInput, ParsedChunk, ParserDefinition, ParserId, ResolvedParserConfig } from "./types"

export * from "./types"

const PROSE_FORMATS = ["pdf", "docx", "txt", "md", "html", "csv", "tsv", "json", "eml"] as const

/**
 * The catalogue. Everything about a strategy that a screen, an upload check or
 * the pipeline needs is here, so adding one is a single entry rather than a
 * change in four places.
 */
export const PARSERS: Record<ParserId, ParserDefinition> = {
	general: {
		id: "general",
		name: "General",
		description:
			"Splits at sentence boundaries and merges back to a token budget, with overlap. The default, and the right choice for prose with no structure worth keeping.",
		formats: PROSE_FORMATS,
		parse: parseGeneral,
	},
	qa: {
		id: "qa",
		name: "Q&A",
		description:
			"One chunk per question-and-answer pair, with the question embedded rather than the answer. For FAQs, support exports and interview transcripts.",
		formats: ["csv", "tsv", "md", "txt", "docx"],
		parse: parseQa,
	},
	table: {
		id: "table",
		name: "Table",
		description:
			"One chunk per row, each carrying its column names. Export a spreadsheet as CSV or TSV first — Ragenta does not read XLSX.",
		formats: ["csv", "tsv"],
		parse: parseTable,
	},
	one: {
		id: "one",
		name: "One",
		description:
			"The whole document as a single chunk. For short documents where every part is context for every other — a one-page policy, a product sheet.",
		formats: PROSE_FORMATS,
		parse: parseOne,
	},
	paper: {
		id: "paper",
		name: "Paper",
		description:
			"Splits on academic section names — Abstract, Method, Results — and prefixes each chunk with its section.",
		formats: ["pdf", "docx", "txt", "md", "html"],
		parse: (input) => parseStructured("paper", input),
	},
	book: {
		id: "book",
		name: "Book",
		description:
			"Splits on chapters and numbered headings, prefixing each chunk with its heading path.",
		formats: ["pdf", "docx", "txt", "md", "html"],
		parse: (input) => parseStructured("book", input),
	},
	laws: {
		id: "laws",
		name: "Legal",
		description:
			"One chunk per article — Điều, Article, 第N条 — never merged with its neighbours, because a provision is the boundary a legal answer needs.",
		formats: ["pdf", "docx", "txt", "md", "html"],
		parse: (input) => parseStructured("laws", input),
	},
	manual: {
		id: "manual",
		name: "Manual",
		description:
			"Splits on numbered sections and keeps the section number with the text, so a procedure step still says which procedure it belongs to.",
		formats: ["pdf", "docx", "txt", "md", "html"],
		parse: (input) => parseStructured("manual", input),
	},
	presentation: {
		id: "presentation",
		name: "Presentation",
		description:
			"One chunk per slide, never merged. Export the deck as PDF — Ragenta does not read PPTX.",
		formats: ["pdf"],
		parse: parsePresentation,
	},
	email: {
		id: "email",
		name: "Email",
		description:
			"Keeps From, To, Subject and Date with every chunk of the body. Upload the .eml file.",
		formats: ["eml", "txt"],
		parse: parseEmail,
	},
	picture: {
		id: "picture",
		name: "Picture",
		description: "Images and scanned pages, read by a vision model.",
		formats: [],
		unavailable:
			"Ragenta has no OCR or vision model wired in, so an image yields no text. Convert the file to a text PDF first.",
	},
	audio: {
		id: "audio",
		name: "Audio",
		description: "Recordings, transcribed before indexing.",
		formats: [],
		unavailable:
			"Ragenta has no speech-to-text provider. Transcribe the recording and upload the transcript.",
	},
	resume: {
		id: "resume",
		name: "Resume",
		description: "CVs, parsed into structured fields before indexing.",
		formats: [],
		unavailable:
			"Ragenta has no entity-extraction model for this. Use General, which indexes a CV as prose.",
	},
}

export const PARSER_LIST = Object.values(PARSERS)

export function findParser(id: string): ParserDefinition | undefined {
	return PARSERS[id as ParserId]
}

/**
 * The stored shape. Every field optional — a knowledge base created before a
 * knob existed must keep working, and a document override sets only what it
 * differs on.
 */
export const parserConfigSchema = z
	.object({
		delimiters: z.array(z.string().min(1).max(8)).max(16).optional(),
		pages: z
			.array(z.tuple([z.number().int().min(1), z.number().int().min(1)]))
			.max(32)
			.optional(),
		rowsPerChunk: z.number().int().min(1).max(50).optional(),
		qaColumns: z
			.object({
				question: z.number().int().min(0).max(50),
				answer: z.number().int().min(0).max(50),
			})
			.optional(),
		autoKeywords: z.number().int().min(0).max(10).optional(),
		autoQuestions: z.number().int().min(0).max(5).optional(),
		raptor: z
			.object({
				enabled: z.boolean(),
				maxLevels: z.number().int().min(1).max(4).optional(),
				threshold: z.number().min(0.1).max(0.99).optional(),
				maxClusterSize: z.number().int().min(2).max(64).optional(),
			})
			.optional(),
	})
	.strict()

export type ParserConfig = z.infer<typeof parserConfigSchema>

/**
 * Knowledge-base config, then the document's override on top, then the
 * defaults. RAGFlow allows the same two levels and it is genuinely useful: one
 * scanned appendix in an otherwise uniform base needs a different page range,
 * not a second knowledge base.
 */
export function resolveParserConfig(
	base: { chunkTokenSize: number; chunkOverlapPercent: number; parserConfig: unknown },
	override: unknown,
): ResolvedParserConfig {
	const merged = {
		...(parserConfigSchema.safeParse(base.parserConfig).data ?? {}),
		...(parserConfigSchema.safeParse(override).data ?? {}),
	}

	return {
		tokenSize: base.chunkTokenSize,
		overlapPercent: base.chunkOverlapPercent,
		delimiters: merged.delimiters ?? [],
		pages: merged.pages ?? null,
		rowsPerChunk: merged.rowsPerChunk ?? 1,
		qaColumns: merged.qaColumns ?? { question: 0, answer: 1 },
		autoKeywords: merged.autoKeywords ?? 0,
		autoQuestions: merged.autoQuestions ?? 0,
		raptor: {
			enabled: merged.raptor?.enabled ?? false,
			maxLevels: merged.raptor?.maxLevels ?? 3,
			threshold: merged.raptor?.threshold ?? 0.6,
			maxClusterSize: merged.raptor?.maxClusterSize ?? 16,
		},
	}
}

/**
 * Refuses a strategy that cannot read this file, at upload, with the formats it
 * can read in the message. The alternative is a document that uploads cleanly
 * and fails in the worker where nobody is watching.
 */
export function assertParserAccepts(parserId: string, format: string, filename: string): void {
	const parser = findParser(parserId)
	if (!parser) throw new ValidationError(`Unknown chunking method "${parserId}".`)
	if (!parser.parse) {
		throw new ValidationError(`${parser.name} is not available. ${parser.unavailable}`)
	}
	if (!parser.formats.includes(format)) {
		throw new ValidationError(
			`The ${parser.name} method cannot read ${filename}. It accepts: ${parser.formats.join(", ")}.`,
			{ parserId, format },
		)
	}
}

export async function runParser(parserId: string, input: ParseInput): Promise<ParsedChunk[]> {
	const parser = findParser(parserId)
	if (!parser?.parse) {
		throw new ValidationError(
			`The chunking method "${parserId}" is not available on this deployment.`,
		)
	}
	return parser.parse(input)
}
