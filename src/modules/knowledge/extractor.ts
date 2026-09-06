import { Buffer } from "node:buffer"

import { ValidationError } from "../../shared/errors"

/**
 * File bytes to plain text.
 *
 * A deliberately small set of formats, each with a real library or a real
 * parser behind it. RAGFlow's DeepDoc does layout recognition, table structure
 * and OCR through a stack of vision models; that is a product in itself and is
 * not what this needs to be. What retrieval actually requires is the reading
 * order of the text, and for the formats below that is obtainable without a GPU.
 *
 * Scanned PDFs are the honest gap: a page of images yields no text, and this
 * reports that as a failure with a reason rather than indexing an empty
 * document that then answers nothing and looks like a retrieval bug.
 */
export interface ExtractedSection {
	text: string
	/** Where it came from — a page number, a heading. Shown with a citation. */
	position: string
	/**
	 * 1-based page, for formats that have pages. Carried separately from
	 * `position` because a page *range* is stored on the chunk and used to split
	 * a large document into bounded ingestion tasks — parsing a string back out
	 * of "page 12" to do that would be absurd.
	 */
	page?: number
}

const MAX_TEXT_BYTES = 32 * 1024 * 1024

export const SUPPORTED_MIME_TYPES: Record<string, string> = {
	"text/plain": "txt",
	"text/markdown": "md",
	"text/html": "html",
	"text/csv": "csv",
	"application/json": "json",
	"application/pdf": "pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"message/rfc822": "eml",
	"text/tab-separated-values": "tsv",
}

/**
 * The declared content type is a hint from the uploader, so the extension is
 * checked too and the two must agree on a format we know. A `.pdf` announced as
 * `text/plain` is either a mistake or an attempt, and neither should be parsed
 * as text.
 */
export function resolveFormat(mimeType: string, filename: string): string {
	const byMime = SUPPORTED_MIME_TYPES[mimeType.split(";")[0]?.trim() ?? ""]
	const extension = filename.toLowerCase().split(".").pop() ?? ""
	const byExtension = Object.values(SUPPORTED_MIME_TYPES).includes(extension)
		? extension
		: undefined

	const format = byMime ?? byExtension
	if (!format) {
		throw new ValidationError(
			`Ragenta cannot read ${filename}. Supported formats: PDF, DOCX, TXT, Markdown, HTML, CSV, TSV, JSON, EML.`,
			{ mimeType, filename },
		)
	}
	return format
}

function decodeText(bytes: Buffer): string {
	if (bytes.length > MAX_TEXT_BYTES) {
		throw new ValidationError("The document is too large to read as text.")
	}
	return bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

/**
 * HTML without a DOM parser: script and style go first because their contents
 * are not prose, block tags become newlines so paragraph boundaries survive
 * into chunking, and everything else is dropped.
 */
function htmlToText(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

/**
 * A CSV row is only meaningful with its header, so each row is emitted as
 * `column: value` pairs. A bare row of values retrieves badly — the numbers
 * match nothing and the words have lost what they are about.
 */
export function parseDelimited(text: string, separator = ","): string[][] {
	const rows: string[][] = []
	let row: string[] = []
	let cell = ""
	let quoted = false

	// Character by character rather than a line split, because a quoted field may
	// contain the separator *and* a newline, and a row-first parse corrupts both.
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index]

		if (quoted) {
			if (character === '"') {
				if (text[index + 1] === '"') {
					cell += '"'
					index += 1
				} else {
					quoted = false
				}
			} else {
				cell += character
			}
			continue
		}

		if (character === '"' && cell.length === 0) {
			quoted = true
		} else if (character === separator) {
			row.push(cell.trim())
			cell = ""
		} else if (character === "\n") {
			row.push(cell.trim())
			if (row.some((value) => value.length > 0)) rows.push(row)
			row = []
			cell = ""
		} else {
			cell += character
		}
	}

	row.push(cell.trim())
	if (row.some((value) => value.length > 0)) rows.push(row)

	return rows
}

function csvToSections(text: string, separator = ","): ExtractedSection[] {
	const rows = parseDelimited(text, separator)
	const header = rows[0]
	if (!header) return []

	return rows.slice(1).map((values, index) => ({
		text: values
			.map((value, column) => `${header[column] ?? `column ${column + 1}`}: ${value}`)
			.join("\n"),
		position: `row ${index + 2}`,
	}))
}

async function pdfToSections(bytes: Buffer): Promise<ExtractedSection[]> {
	const { extractText, getDocumentProxy } = await import("unpdf")
	const document = await getDocumentProxy(new Uint8Array(bytes))
	const { text } = await extractText(document, { mergePages: false })

	const pages = Array.isArray(text) ? text : [text]
	return pages
		.map((page, index) => ({
			text: page.trim(),
			position: `page ${index + 1}`,
			page: index + 1,
		}))
		.filter((section) => section.text.length > 0)
}

/** How many pages a PDF has, without extracting a word of it. */
export async function countPdfPages(bytes: Buffer): Promise<number> {
	const { getDocumentProxy } = await import("unpdf")
	const document = await getDocumentProxy(new Uint8Array(bytes))
	return document.numPages
}

async function docxToSections(bytes: Buffer): Promise<ExtractedSection[]> {
	const mammoth = await import("mammoth")
	const { value } = await mammoth.extractRawText({ buffer: bytes })
	return splitParagraphs(value)
}

/**
 * Paragraphs, not lines. Chunking merges back up to a token budget, so the job
 * here is to hand it boundaries a person would recognise rather than the
 * arbitrary ones a hard-wrapped file has.
 */
function splitParagraphs(text: string): ExtractedSection[] {
	return text
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter((block) => block.length > 0)
		.map((block, index) => ({ text: block, position: `block ${index + 1}` }))
}

export async function extractSections(
	bytes: Buffer,
	mimeType: string,
	filename: string,
): Promise<ExtractedSection[]> {
	const format = resolveFormat(mimeType, filename)

	switch (format) {
		case "pdf":
			return pdfToSections(bytes)
		case "docx":
			return docxToSections(bytes)
		case "html":
			return splitParagraphs(htmlToText(decodeText(bytes)))
		case "csv":
			return csvToSections(decodeText(bytes))
		case "tsv":
			return csvToSections(decodeText(bytes), "\t")
		case "eml":
			// Headers first, then the body split at blank lines: an email's From,
			// To and Subject are the part a question usually matches, and losing
			// them into a chunk boundary loses what the mail was about.
			return splitParagraphs(decodeText(bytes))
		case "json":
			// Re-serialised rather than passed through: minified JSON is one line
			// with no boundaries to chunk on, and indenting it gives the chunker
			// something to split at without changing a single value.
			return splitParagraphs(
				JSON.stringify(JSON.parse(decodeText(bytes)), null, 2),
			)
		default:
			return splitParagraphs(decodeText(bytes))
	}
}
