import { Buffer } from "node:buffer"

import { chunkSections } from "../chunker"
import { toParsedChunks } from "./shared"
import type { ParseInput, ParsedChunk } from "./types"

/**
 * RAGFlow's "Email": the headers are kept with every chunk of the body.
 *
 * Who sent it, to whom, when and about what is usually the part a question
 * matches — "what did legal say about the renewal in March" is answered by the
 * envelope, not by the prose. A body chunked without its headers loses all four,
 * so they become the chunk prefix rather than a chunk of their own.
 *
 * MIME is read only as far as this needs: headers up to the first blank line,
 * quoted-printable undone, and a multipart mail reduced to its text part. A
 * full MIME parser is a dependency, and an attachment is a document in its own
 * right that should be uploaded as one.
 */
const KEPT_HEADERS = ["from", "to", "cc", "subject", "date"]

export async function parseEmail(input: ParseInput): Promise<ParsedChunk[]> {
	const text = decode(input.bytes)
	const separator = text.indexOf("\n\n")
	const rawHeaders = separator === -1 ? "" : text.slice(0, separator)
	const rawBody = separator === -1 ? text : text.slice(separator + 2)

	const headers = parseHeaders(rawHeaders)
	const prefix = KEPT_HEADERS.flatMap((name) => {
		const value = headers.get(name)
		return value ? [`${titleCase(name)}: ${value}`] : []
	}).join("\n")

	const body = stripQuotedPrintable(selectTextPart(rawBody, headers))
	const sections = body
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter((block) => block.length > 0)
		.map((block, index) => ({ text: block, position: `block ${index + 1}` }))

	if (sections.length === 0) {
		return prefix.length > 0
			? toParsedChunks(
					chunkSections([{ text: prefix, position: "headers" }], {
						tokenSize: input.config.tokenSize,
						overlapPercent: 0,
					}),
				)
			: []
	}

	return toParsedChunks(
		chunkSections(sections, {
			tokenSize: input.config.tokenSize,
			overlapPercent: input.config.overlapPercent,
			delimiters: input.config.delimiters,
			prefix,
		}),
	)
}

function decode(bytes: Buffer): string {
	return bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

/** Header names are case-insensitive and a value may continue on an indented line. */
function parseHeaders(raw: string): Map<string, string> {
	const headers = new Map<string, string>()
	let name = ""

	for (const line of raw.split("\n")) {
		if (/^\s/.test(line) && name) {
			headers.set(name, `${headers.get(name) ?? ""} ${line.trim()}`)
			continue
		}
		const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
		if (!match?.[1]) continue
		name = match[1].toLowerCase()
		headers.set(name, (match[2] ?? "").trim())
	}

	return headers
}

/**
 * A multipart mail carries the same message twice — once as text, once as HTML.
 * Indexing both would double every chunk and rank the HTML copy alongside its
 * own plain-text twin, so the first text part wins and the rest is dropped.
 */
function selectTextPart(body: string, headers: Map<string, string>): string {
	const boundary = /boundary="?([^";\s]+)"?/i.exec(headers.get("content-type") ?? "")?.[1]
	if (!boundary) return body

	for (const part of body.split(`--${boundary}`)) {
		const separator = part.indexOf("\n\n")
		if (separator === -1) continue
		const partHeaders = parseHeaders(part.slice(0, separator))
		if ((partHeaders.get("content-type") ?? "").startsWith("text/plain")) {
			return part.slice(separator + 2).trim()
		}
	}

	return body
}

function stripQuotedPrintable(text: string): string {
	if (!/=[0-9A-F]{2}/.test(text)) return text
	return text
		.replace(/=\n/g, "")
		.replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		)
}

function titleCase(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1)
}
