import type { AttachmentExtraction } from "../../db/schema/attachment.schema"

/**
 * Turning whatever a model actually replied into the one stored extraction
 * shape.
 *
 * Pure, and by contract it never throws. A model asked for "JSON only" complies
 * most of the time and not always: it fences the object, apologises before it,
 * adds a key nobody asked for, or answers in prose because the page was blank.
 * None of that is worth failing an extraction over — the reply is still the text
 * the model read out of the image, and keeping it as `text` leaves the user with
 * something usable, while a parse error leaves them with a failed attachment and
 * a bill for the call anyway.
 */

export interface ExtractionSource {
	provider: string
	model?: string
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The forms a "JSON only" reply arrives in, tried in order: the bare object,
 * the body of a ```json fence, and the widest brace-delimited slice for a reply
 * with prose around it.
 */
function parseReply(text: string): JsonObject | null {
	const candidates = [text]

	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
	if (fenced?.[1] !== undefined) candidates.push(fenced[1])

	const start = text.indexOf("{")
	const end = text.lastIndexOf("}")
	if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1))

	for (const candidate of candidates) {
		try {
			const parsed: unknown = JSON.parse(candidate)
			if (isObject(parsed)) return parsed
		} catch {
			// Not this form. The next candidate is the point of having them.
		}
	}
	return null
}

function asString(value: unknown): string | null {
	if (typeof value === "string") return value
	if (typeof value === "number" || typeof value === "boolean") return String(value)
	if (value === null || value === undefined) return null
	return JSON.stringify(value) ?? null
}

function normalizeFields(value: unknown): Record<string, string> {
	if (!isObject(value)) return {}

	const fields: Record<string, string> = {}
	for (const [key, raw] of Object.entries(value)) {
		const text = asString(raw)
		// A null value is a label the model found and could not fill. Storing the
		// word "null" against it would read back as the document's own answer.
		if (text !== null) fields[key] = text
	}
	return fields
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" }

function escapeHtml(value: string): string {
	return value.replace(/[&<>]/g, (char) => HTML_ESCAPES[char] ?? char)
}

function rowsToHtml(rows: string[][]): string {
	const body = rows
		.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
		.join("")
	return `<table>${body}</table>`
}

function normalizeRows(value: unknown): string[][] | undefined {
	if (!Array.isArray(value)) return undefined

	const rows = value
		.filter((row): row is unknown[] => Array.isArray(row))
		.map((row) => row.map((cell) => asString(cell) ?? ""))
	return rows.length > 0 ? rows : undefined
}

function readHtml(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry
	if (isObject(entry) && typeof entry.html === "string") return entry.html
	return undefined
}

function readRows(entry: unknown): string[][] | undefined {
	if (Array.isArray(entry)) return normalizeRows(entry)
	if (isObject(entry)) return normalizeRows(entry.rows)
	return undefined
}

function normalizeTables(value: unknown): AttachmentExtraction["tables"] {
	if (!Array.isArray(value)) return []

	const tables: AttachmentExtraction["tables"] = []
	for (const entry of value) {
		// A model asked for `{html}` answers just as often with the markup on its
		// own or with the rows on their own. Both are the table it was asked for.
		const html = readHtml(entry)
		const rows = readRows(entry)

		if (html && html.trim().length > 0) {
			tables.push(rows ? { html, rows } : { html })
		} else if (rows) {
			// The stored shape requires markup, so rows alone become the plainest
			// table that means the same thing.
			tables.push({ html: rowsToHtml(rows), rows })
		}
	}
	return tables
}

function normalizePageCount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined
	return value
}

/**
 * The reply of the text-only field pass (`fields.ts`), which is asked for
 * `{"fields": {...}}` and sometimes answers with the bare object instead. Kept
 * here so every tolerance rule — fences, prose, wrong types, nulls — lives in
 * one pure, tested place rather than once per call site.
 */
export function normalizeFieldsReply(reply: string): Record<string, string> {
	try {
		const parsed = parseReply(typeof reply === "string" ? reply.trim() : "")
		if (!parsed) return {}
		return normalizeFields(isObject(parsed.fields) ? parsed.fields : parsed)
	} catch {
		return {}
	}
}

export function normalizeExtraction(
	reply: string,
	source: ExtractionSource,
): AttachmentExtraction {
	const raw = typeof reply === "string" ? reply.trim() : ""
	const metadata: AttachmentExtraction["metadata"] = {
		provider: source.provider,
		model: source.model,
		// `meanConfidence` is left unset on purpose. A language model reports no
		// per-line confidence, and a number invented here would be read
		// downstream as evidence the transcription is sound. A real OCR engine
		// reports one and fills it in itself.
	}

	try {
		const parsed = parseReply(raw)
		if (!parsed) return { text: raw, tables: [], fields: {}, metadata }

		return {
			text: typeof parsed.text === "string" ? parsed.text.trim() : "",
			tables: normalizeTables(parsed.tables),
			fields: normalizeFields(parsed.fields),
			metadata: { ...metadata, pageCount: normalizePageCount(parsed.pageCount) },
		}
	} catch {
		// The contract is that this function does not throw: an unexpected reply
		// must degrade to its raw text, never take the whole extraction down.
		return { text: raw, tables: [], fields: {}, metadata }
	}
}
