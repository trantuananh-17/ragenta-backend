import { Buffer } from "node:buffer"

import { parseDelimited } from "../extractor"
import { MIN_CHUNK_TOKENS, parsedChunk } from "./shared"
import type { ParseInput, ParsedChunk } from "./types"

function decode(bytes: Buffer): string {
	return bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

/**
 * RAGFlow's "Table": one chunk per row, each carrying its column names.
 *
 * A bare row of values retrieves badly — the numbers match nothing and the
 * words have lost what they are about — so every cell is rendered as
 * `column: value`. `rowsPerChunk` above 1 groups consecutive rows, which is
 * worth doing for narrow tables where a single row is a handful of tokens.
 *
 * XLSX is not read; Ragenta ships no Office XML parser, and "export as CSV" is
 * one click. The strategy refuses the file at upload rather than mis-parsing it.
 */
export async function parseTable(input: ParseInput): Promise<ParsedChunk[]> {
	const separator = input.format === "tsv" ? "\t" : ","
	const rows = parseDelimited(decode(input.bytes), separator)
	const header = rows[0]
	if (!header) return []

	const body = rows.slice(1)
	const group = Math.max(1, input.config.rowsPerChunk)
	const chunks: ParsedChunk[] = []

	for (let offset = 0; offset < body.length; offset += group) {
		const slice = body.slice(offset, offset + group)
		const rendered = slice
			.map((values) =>
				values
					.map((value, column) => `${header[column] ?? `column ${column + 1}`}: ${value}`)
					.join("\n"),
			)
			.join("\n\n")

		if (rendered.trim().length === 0) continue

		const first = offset + 2
		const last = offset + slice.length + 1
		chunks.push(
			parsedChunk(
				rendered,
				first === last ? `row ${first}` : `rows ${first}–${last}`,
				"row",
			),
		)
	}

	return chunks
}

/**
 * RAGFlow's "Q&A": each pair becomes one chunk, and the **question** is what
 * gets embedded.
 *
 * That inversion is the whole point of the strategy. A user's question matches
 * another question far better than it matches the prose of an answer, so a FAQ
 * indexed as ordinary passages retrieves worse than the same FAQ indexed as
 * pairs. `ParsedChunk.question` is what the pipeline embeds; `content` is the
 * pair, and it is what the model is shown and what a citation displays.
 *
 * Four input shapes, in the order they are tried:
 *
 *  1. Two-column CSV/TSV — RAGFlow's own Excel path, minus Excel.
 *  2. `Q:` / `A:` prefixed lines, the plain-text convention.
 *  3. Markdown headings, where the heading is the question and the body is the
 *     answer — which is what an exported FAQ page looks like.
 *  4. Blank-line separated blocks whose first line ends in a question mark.
 */
export async function parseQa(input: ParseInput): Promise<ParsedChunk[]> {
	const text = decode(input.bytes)

	const pairs =
		input.format === "csv" || input.format === "tsv"
			? fromDelimited(text, input.format === "tsv" ? "\t" : ",", input.config.qaColumns)
			: fromProse(text)

	return pairs
		.map(({ question, answer }, index) =>
			parsedChunk(`Q: ${question}\nA: ${answer}`, `pair ${index + 1}`, "qa", {
				question,
			}),
		)
		.filter((chunk) => chunk.tokenCount >= MIN_CHUNK_TOKENS)
}

interface Pair {
	question: string
	answer: string
}

function fromDelimited(
	text: string,
	separator: string,
	columns: { question: number; answer: number },
): Pair[] {
	const rows = parseDelimited(text, separator)
	if (rows.length === 0) return []

	// A header row is a convention, not a guarantee, so it is dropped only when
	// its first cell reads like a column name rather than like a question.
	const first = rows[0]
	const looksLikeHeader =
		first !== undefined &&
		/^(question|q|câu hỏi|问题)$/i.test((first[columns.question] ?? "").trim())

	return (looksLikeHeader ? rows.slice(1) : rows)
		.map((values) => ({
			question: (values[columns.question] ?? "").trim(),
			answer: (values[columns.answer] ?? "").trim(),
		}))
		.filter((pair) => pair.question.length > 0 && pair.answer.length > 0)
}

const QUESTION_PREFIX = /^(q|question|câu hỏi|hỏi|问)\s*[:.）)、]\s*/i
const ANSWER_PREFIX = /^(a|answer|trả lời|đáp án|答)\s*[:.）)、]\s*/i

function fromProse(text: string): Pair[] {
	const prefixed = fromPrefixedLines(text)
	if (prefixed.length > 0) return prefixed

	const headed = fromHeadings(text)
	if (headed.length > 0) return headed

	return fromBlocks(text)
}

function fromPrefixedLines(text: string): Pair[] {
	const pairs: Pair[] = []
	let question = ""
	let answer: string[] = []

	const flush = () => {
		if (question.length > 0 && answer.length > 0) {
			pairs.push({ question, answer: answer.join("\n").trim() })
		}
		question = ""
		answer = []
	}

	for (const raw of text.split("\n")) {
		const line = raw.trim()
		if (QUESTION_PREFIX.test(line)) {
			flush()
			question = line.replace(QUESTION_PREFIX, "").trim()
		} else if (ANSWER_PREFIX.test(line)) {
			answer.push(line.replace(ANSWER_PREFIX, "").trim())
		} else if (question.length > 0 && line.length > 0) {
			answer.push(line)
		}
	}

	flush()
	return pairs
}

function fromHeadings(text: string): Pair[] {
	const pairs: Pair[] = []
	let question = ""
	let answer: string[] = []

	const flush = () => {
		if (question.length > 0 && answer.length > 0) {
			pairs.push({ question, answer: answer.join("\n").trim() })
		}
		answer = []
	}

	for (const raw of text.split("\n")) {
		const line = raw.trim()
		const heading = /^#{1,6}\s+(\S.*)$/.exec(line)
		if (heading?.[1]) {
			flush()
			question = heading[1].trim()
		} else if (question.length > 0 && line.length > 0) {
			answer.push(line)
		}
	}

	flush()
	return pairs
}

function fromBlocks(text: string): Pair[] {
	return text
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter((block) => block.length > 0)
		.flatMap((block) => {
			const lines = block.split("\n")
			const head = (lines[0] ?? "").trim()
			const body = lines.slice(1).join("\n").trim()
			// Only a block whose first line is actually a question. Anything else
			// would turn ordinary prose into fabricated Q&A pairs.
			if (!/[?？]$/.test(head) || body.length === 0) return []
			return [{ question: head, answer: body }]
		})
}
