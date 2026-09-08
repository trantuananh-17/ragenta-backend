import { z } from "zod"

import { ValidationError } from "../../../shared/errors"

/**
 * The pure half of the flow's tool nodes: what a node may be configured with,
 * and the arithmetic that bounds a loop.
 *
 * Separate from `nodes.ts` because that file reaches the retrieval service, the
 * tool registry and the provider clients, and so pulls in `config/env` — the
 * unit suite runs on a runner with no environment and no infrastructure at all
 * (`vitest.config.ts`). Keeping the schemas and the bounding here is what lets
 * them be tested rather than only compiled, which for a loop's limits is the
 * difference between a proven bound and a hoped-for one.
 */

/**
 * A parameter that may be written as `{{node.field}}`.
 *
 * Deliberately looser than the tool schema it feeds: `{{page.url}}` is not a URL
 * and `{{list.first}}` is not an attachment id, so the *shape* is checked after
 * the template is resolved, by the tool — which is where that check already
 * lives and where it stays one implementation.
 */
const template = z.string().min(1).max(4_000)

/** Sizes taken from the tools these nodes call, so a node cannot configure a call the tool will refuse. */
const SHEET_NAME_CHARACTERS = 31
const MAX_SELECTORS = 5

export const httpNodeParams = z.object({
	url: template,
	method: z.enum(["GET", "POST"]).default("GET"),
	body: z.string().max(4_000).default(""),
})

export const ocrNodeParams = z.object({ attachmentId: template })

export const visionNodeParams = z.object({
	attachmentId: template,
	question: template,
})

export const sttNodeParams = z.object({
	attachmentId: template,
	/** ISO 639-1, as the transcription tool takes it. Detected when omitted. */
	language: z.string().trim().length(2).optional(),
})

export const ttsNodeParams = z.object({
	text: template,
	voice: z.string().trim().min(1).max(100).optional(),
})

/**
 * One node for both spreadsheet tools, chosen by `operation`.
 *
 * Reading and writing a workbook are the same thing to whoever is drawing the
 * flow — "the spreadsheet step" — and two node types would put the choice in the
 * canvas's palette instead of in the node's own form, where the fields that go
 * with each choice already are.
 */
export const excelNodeParams = z.discriminatedUnion("operation", [
	z.object({
		operation: z.literal("read"),
		attachmentId: template,
		sheet: z.string().trim().min(1).max(SHEET_NAME_CHARACTERS).optional(),
	}),
	z.object({
		operation: z.literal("write"),
		fileName: z.string().trim().min(1).max(120).optional(),
		/**
		 * An uploaded .xlsx to fill in, rather than a blank workbook. Rows land
		 * below what the sheet already holds; the template is never modified,
		 * because a run that fills a form must not consume the blank one.
		 */
		templateAttachmentId: template.optional(),
		/**
		 * The rows, as one template resolving to a list.
		 *
		 * A grid typed at design time cannot express "one row per thing the run
		 * found", which is what a flow writing a spreadsheet is nearly always for.
		 * One template can: it resolves against the same values every other field
		 * does, so `{{extract.text}}` producing a JSON array becomes as many rows
		 * as the model wrote.
		 *
		 * Optional so a graph published against `sheets` keeps working; when it is
		 * set it decides, because two sources for one thing means the one that
		 * loses is the one somebody spends an afternoon on.
		 */
		rows: template.optional(),
		rowsFormat: z.enum(["json", "lines"]).default("json"),
		sheetName: z.string().trim().min(1).max(SHEET_NAME_CHARACTERS).default("Sheet1"),
		sheets: z
			.array(
				z.object({
					name: z.string().trim().min(1).max(SHEET_NAME_CHARACTERS),
					/** Every cell is a template, so a row can be built from earlier nodes. */
					rows: z.array(z.array(z.string().max(500)).max(100)).min(1).max(2_000),
				}),
			)
			.min(1)
			.max(10)
			.optional(),
	}),
]).superRefine((params, ctx) => {
	/*
		Both row sources are optional so that a graph published against either one
		keeps parsing, which leaves "neither" expressible — and a write with
		nothing to write does not fail, it produces an empty workbook and a step
		that looks like it worked. Making `sheets` optional is what opened this;
		refusing it here is what closes it.
	*/
	if (params.operation === "write" && !params.rows && !params.sheets) {
		ctx.addIssue({
			code: "custom",
			path: ["rows"],
			message: "A spreadsheet step has to be told what rows to write.",
		})
	}
})

export const browserNodeParams = z.object({
	url: template,
	selectors: z.array(z.string().trim().min(1).max(200)).min(1).max(MAX_SELECTORS).optional(),
})

/**
 * The ceiling on one loop node, on top of the run-wide `MAX_NODE_EXECUTIONS`.
 *
 * Two bounds rather than one because they answer different questions: this one
 * is what a flow author may ask for, the run budget is what the run may afford.
 * A list of ten thousand rows must not become ten thousand model calls because
 * somebody typed a big number into a form.
 */
export const MAX_LOOP_ITERATIONS = 25

/** The value scope a loop's body reads its item out of: `{{loop.item}}`. */
export const LOOP_SCOPE = "loop"

export const loopNodeParams = z.object({
	/** A template producing the list, e.g. `{{search.text}}`. */
	items: template,
	format: z.enum(["lines", "json"]).default("lines"),
	/** The one downstream node run per item. Checked as an edge by `validateGraph`. */
	body: z.string().trim().min(1).max(64),
	maxIterations: z.number().int().min(1).max(MAX_LOOP_ITERATIONS).default(10),
})

export type LoopNodeParams = z.infer<typeof loopNodeParams>

/**
 * Turns the resolved `items` text into the list the body runs over.
 *
 * Two formats and no third: a node's output is text, and text that holds a list
 * is either a line per item or a JSON array. A CSV or a regular expression
 * splitter would be a third way to get quoting wrong.
 *
 * A `json` value that is not an array throws rather than becoming one item —
 * looping once over `{"rows": [...]}` looks like it worked and is not what
 * anybody asked for.
 */
export function parseLoopItems(text: string, format: "lines" | "json"): string[] {
	if (format === "lines") {
		return text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new ValidationError("This flow's loop expected a JSON list and did not get one.")
	}

	if (!Array.isArray(parsed)) {
		throw new ValidationError("This flow's loop expected a JSON list, not a single value.")
	}

	// An object stays an object the body can read back with `JSON.parse`. String
	// items pass through untouched, so a list of ids is a list of ids and not a
	// list of quoted ids.
	return (parsed as unknown[]).map((item) =>
		typeof item === "string" ? item : JSON.stringify(item),
	)
}

/**
 * How many iterations a loop actually runs: the smallest of what it was given,
 * what it was allowed, and what the run can still afford.
 *
 * The budget term is the one that matters. `maxIterations` is a flow author's
 * intent and `MAX_NODE_EXECUTIONS` is the run's hard ceiling, so a loop that
 * respected only its own number could spend a budget the rest of the flow was
 * counting on. Never negative: a run already at its ceiling runs the body zero
 * times rather than looping backwards.
 */
export function plannedIterations(input: {
	items: number
	maxIterations: number
	remaining: number
}): number {
	return Math.max(Math.min(input.items, input.maxIterations, input.remaining), 0)
}

/**
 * The metadata fields a later node has a reason to reference.
 *
 * `{{speak.attachmentId}}` is what makes "answer, then say it aloud, then attach
 * the recording" one flow. Copying all of `metadata` instead would offer a
 * page's entire text as a canvas variable and put a spreadsheet's sheet list in
 * a string.
 */
const CARRIED_METADATA = [
	"attachmentId",
	"fileName",
	"status",
	"finalUrl",
	"cached",
	"language",
	"characters",
] as const

/** The referenceable values of a tool result, as strings. Objects are dropped, not stringified. */
export function carriedValues(metadata: Record<string, unknown> | undefined): Record<string, string> {
	const values: Record<string, string> = {}
	if (!metadata) return values

	for (const key of CARRIED_METADATA) {
		const value = metadata[key]
		if (typeof value === "string") values[key] = value
		else if (typeof value === "number" || typeof value === "boolean") values[key] = String(value)
	}
	return values
}

/**
 * Turns a resolved `rows` template into the cells a workbook is written from.
 *
 * Two formats, and no CSV, for the reason `parseLoopItems` gives: a separator
 * inside a value is a quoting problem, and a spreadsheet is exactly where a
 * value contains a comma. `json` is an array of rows, each an array of cells —
 * the shape a model asked for a table produces. `lines` is one row per line,
 * whole, for the case where each row is a single value.
 */
/** CRLF as well as LF: a list pasted from a Windows editor is a list. */
const LINE_BREAK = /\r?\n/

export function parseWorkbookRows(text: string, format: "json" | "lines"): string[][] {
	if (format === "lines") {
		return text
			.split(LINE_BREAK)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => [line])
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new ValidationError("This flow's spreadsheet step expected a JSON list of rows.")
	}

	if (!Array.isArray(parsed)) {
		throw new ValidationError(
			"This flow's spreadsheet step expected a JSON list of rows, not a single value.",
		)
	}

	// A row given as a bare value becomes a one-cell row rather than being
	// refused: a model asked for a single column answers with `["a","b"]` about as
	// often as with `[["a"],["b"]]`, and both mean the same table.
	return parsed.map((row) =>
		Array.isArray(row)
			? row.map((cell) => (typeof cell === "string" ? cell : JSON.stringify(cell)))
			: [typeof row === "string" ? row : JSON.stringify(row)],
	)
}
