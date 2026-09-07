import { Buffer } from "node:buffer"

import ExcelJS from "exceljs"

import { isAppError } from "../../../shared/errors"
import { newId } from "../../../shared/id"
import { attachmentKey, getObject, isStorageConfigured, putObject } from "../../../storage/objects"
import { attachmentRepository } from "../../attachment/attachment.repository"
import { attachmentService } from "../../attachment/attachment.service"
import {
	excelReadParameters,
	excelWriteParameters,
	MAX_ROWS_READ,
	MAX_SHEETS_READ,
	readSheetRows,
	renderWorkbook,
	renderWorkbookWritten,
} from "./excel-content"
import type { ExcelWriteInput, SheetRows } from "./excel-content"
import type { AgentTool, ToolContext, ToolResult } from "./types"

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/**
 * A ceiling on the object we are willing to parse, not on the object we will
 * store. `xlsx.load` inflates a zipped workbook into a full object graph in
 * memory, and a 100 MB export would take the API process down with it while a
 * run that only wanted the header row waited.
 */
const MAX_SPREADSHEET_BYTES = 15 * 1024 * 1024

/**
 * Read a spreadsheet attachment.
 *
 * The interesting work is all in `excel-content.ts`: this file is the tool's
 * contract with the model and the place infrastructure is touched, that one is
 * where a cell becomes text and where the caps live. `row.values` is never read
 * here — `readRowCells` owns the column-number indexing, so there is one place
 * for the off-by-one to be right.
 */
export const excelReadTool: AgentTool = {
	name: "excel_read",
	description:
		"Read a spreadsheet attachment and return its sheets as rows you can quote and reason over. Give it the attachment id, and a sheet name if you want only one. Large sheets are truncated, and the result says when they were.",
	parameters: excelReadParameters,
	writes: false,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = excelReadParameters.parse(args)

		if (!isStorageConfigured()) {
			return {
				ok: false,
				content:
					"This deployment has no object storage configured, so attachments cannot be read.",
				metadata: { attachmentId: input.attachmentId, refused: "no_storage" },
			}
		}

		try {
			// The workspace comes from the run and from nowhere else. The attachment
			// id came from the MODEL — read out of a document, echoed from a web page
			// or simply invented — and `findOrFail` puts the workspace in the WHERE
			// clause, so an id belonging to another tenant is a 404 here rather than a
			// spreadsheet this run gets to read (`.claude/rules/security.md`).
			const row = await attachmentService.findOrFail(context.workspaceId, input.attachmentId)

			if (row.kind !== "file") {
				return {
					ok: false,
					content: `Attachment ${input.attachmentId} is a ${row.kind}, not a spreadsheet.`,
					metadata: { attachmentId: input.attachmentId, kind: row.kind, refused: "not_a_file" },
				}
			}
			if (row.sizeBytes > MAX_SPREADSHEET_BYTES) {
				return {
					ok: false,
					content: `That spreadsheet is ${row.sizeBytes} bytes, larger than this tool will open.`,
					metadata: {
						attachmentId: input.attachmentId,
						sizeBytes: row.sizeBytes,
						refused: "too_large",
					},
				}
			}

			const workbook = new ExcelJS.Workbook()
			await workbook.xlsx.load(toArrayBuffer(await getObject(row.storageKey)))

			const selected = input.sheet
				? workbook.worksheets.filter((sheet) => sheet.name === input.sheet)
				: workbook.worksheets

			if (selected.length === 0) {
				const available = workbook.worksheets.map((sheet) => sheet.name).join(", ")
				return {
					ok: false,
					content: input.sheet
						? `That workbook has no sheet called "${input.sheet}". It has: ${available || "no sheets at all"}.`
						: "That workbook has no sheets.",
					metadata: { attachmentId: input.attachmentId, refused: "sheet_not_found" },
				}
			}

			const sheets: SheetRows[] = selected.slice(0, MAX_SHEETS_READ).map((sheet) => {
				const rows: Array<{ number: number; values: unknown }> = []
				// `includeEmpty` so a blank row keeps its number: rows the model has to
				// point back at are the ones a person sees in Excel, and silently
				// closing a gap would renumber every row under it.
				sheet.eachRow({ includeEmpty: true }, (entry, number) => {
					// `eachRow` cannot be broken out of, so the cap is applied here as
					// well as in `readSheetRows`. `entry.values` builds a fresh array
					// per row, and a half-million-row export would build a half-million
					// of them to keep two hundred.
					if (rows.length >= MAX_ROWS_READ) return
					rows.push({ number, values: entry.values })
				})

				return readSheetRows({
					name: sheet.name,
					totalRows: sheet.rowCount,
					totalColumns: sheet.columnCount,
					rows,
				})
			})

			return {
				ok: true,
				content: renderWorkbook({
					fileName: row.fileName,
					totalSheets: selected.length,
					sheets,
				}),
				metadata: {
					attachmentId: input.attachmentId,
					fileName: row.fileName,
					sheets: sheets.map((sheet) => ({
						name: sheet.name,
						totalRows: sheet.totalRows,
						totalColumns: sheet.totalColumns,
						returnedRows: sheet.rows.length,
					})),
				},
			}
		} catch (error) {
			// An id that resolves in no workspace of ours, storage that would not
			// answer, or bytes that are not a workbook at all. A refusal rather than a
			// throw, so a run that has another way to answer still gets to take it
			// (`types.ts`).
			return {
				ok: false,
				content: isAppError(error)
					? error.message
					: "That spreadsheet could not be read. It may not be an .xlsx workbook.",
				metadata: {
					attachmentId: input.attachmentId,
					refused: isAppError(error) ? error.code : "read_failed",
				},
			}
		}
	},
}

/**
 * Build a spreadsheet, and hand back the file as an attachment.
 *
 * This returns an **id, not a file**, for the reason `speech_synthesize` does: a
 * tool result is text the model reads, and a base64 xlsx would be text it cannot
 * open and pays for by the token. The workbook is stored as an unbound
 * `message_attachment` — the state an attachment is in between upload and the
 * message that claims it (ADR-037) — and the id is what comes back. That is what
 * makes "invoice images → OCR → the agent decides the mapping → a workbook" one
 * chain: the next step, a chat message or a workflow output takes the id and
 * delivers the file.
 *
 * `writes: false` although it inserts a row, on the same reading of ADR-032 that
 * `speech_synthesize` uses: the approval gate is about *leaving* Ragenta, and
 * this writes an object into Ragenta's own bucket that nothing points at until
 * somebody chooses to. Getting it wrong costs a little and leaves an orphan.
 * Making it `true` would put a prompt in front of every export step and teach
 * people to click through them.
 */
export const excelWriteTool: AgentTool = {
	name: "excel_write",
	description:
		"Create an .xlsx spreadsheet from rows you supply and save it as a file attachment. Every cell is text, one array per row, and the first row is normally the header. It returns the new attachment's id, not the file — pass that id on to whatever should send, store or deliver it.",
	parameters: excelWriteParameters,
	writes: false,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = excelWriteParameters.parse(args)

		if (!isStorageConfigured()) {
			return {
				ok: false,
				content:
					"This deployment has no object storage configured, so a spreadsheet cannot be saved.",
				metadata: { refused: "no_storage" },
			}
		}

		// Display only; the storage key is generated from the row's id. The run and
		// step make it recognisable on a timeline that may hold several.
		const fileName = `${input.fileName ?? `workbook-${context.runId}-${context.stepSeq}`}.xlsx`

		try {
			const stored = await storeWorkbook(context, fileName, input.sheets)

			return {
				ok: true,
				content: renderWorkbookWritten(stored),
				metadata: { ...stored },
			}
		} catch (error) {
			return {
				ok: false,
				content: isAppError(error) ? error.message : "That spreadsheet could not be saved.",
				metadata: {
					fileName,
					refused: isAppError(error) ? error.code : "write_failed",
				},
			}
		}
	},
}

/**
 * Store generated bytes as an unbound `file` attachment.
 *
 * Not `attachmentService.upload`, which decides what a file is from its own
 * signature and today knows only the image and audio families — an xlsx would be
 * refused there as "not a recording we can read". Teaching that path a `file`
 * branch is the attachment module's change, not this tool's, so the row is
 * written here against the same repository and the same generated key that path
 * uses. `kind: "file"` is already permitted by the table's CHECK constraint, so
 * nothing about the schema changes.
 */
async function storeWorkbook(
	context: ToolContext,
	fileName: string,
	sheets: ExcelWriteInput["sheets"],
) {
	const workbook = new ExcelJS.Workbook()
	for (const sheet of sheets) {
		const worksheet = workbook.addWorksheet(sheet.name)
		for (const row of sheet.rows) worksheet.addRow(row)
	}

	const bytes = Buffer.from(await workbook.xlsx.writeBuffer())

	const id = newId()
	// Generated from the row's id, never from `fileName` — a name the model chose
	// is attacker-influenced, and a key built from one is how a bucket ends up
	// with `../` in it.
	const key = attachmentKey(context.workspaceId, id)
	await putObject(key, bytes, XLSX_MIME_TYPE)

	await attachmentRepository.insert({
		id,
		organizationId: context.workspaceId,
		// Null is the correct value for a run with no human actor — an API-key or
		// scheduled run — and `message_attachment.user_id` is a nullable FK.
		userId: context.userId,
		kind: "file",
		storageKey: key,
		fileName: fileName.slice(0, 300),
		mimeType: XLSX_MIME_TYPE,
		sizeBytes: bytes.byteLength,
		status: "ready",
	})

	return {
		attachmentId: id,
		fileName,
		sizeBytes: bytes.byteLength,
		sheets: sheets.map((sheet) => ({
			name: sheet.name,
			rows: sheet.rows.length,
			columns: sheet.rows.reduce((widest, row) => Math.max(widest, row.length), 0),
		})),
	}
}

/**
 * exceljs types its buffers as `ArrayBuffer`, while object storage hands back a
 * Node `Buffer` — a view that may sit at an offset inside a larger allocation,
 * so the offset has to be honoured rather than the whole backing store passed.
 */
function toArrayBuffer(bytes: Buffer): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
