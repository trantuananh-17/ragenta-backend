import { GOOGLE_SCOPES, callGoogle } from "../../oauth/google-api"
import {
	calendarEventsParameters,
	driveSearchParameters,
	gmailSearchParameters,
	gmailSendParameters,
	renderEvents,
	renderFiles,
	renderMessages,
	renderRows,
	sheetsAppendParameters,
	sheetsReadParameters,
} from "./google-content"
import type { RenderableEvent, RenderableFile, RenderableMessage } from "./google-content"
import type { AgentTool, ToolContext, ToolResult } from "./types"

/**
 * Gmail, Drive, Calendar and Sheets, as the account a workspace connected.
 *
 * The connection is **not** an argument. It is resolved from the workspace, the
 * same rule that governs every other id here: a model that could name a
 * connection could name another workspace's (`.claude/rules/security.md`).
 *
 * Only `gmail_send` and `sheets_append` are marked as writing, which is what the
 * approval gate keys on (ADR-032). Reading somebody's inbox is not nothing, but
 * it is recoverable; a sent email is not.
 */

/** A failure the model should hear about rather than one that ends the run. */
async function attempt(work: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await work()
	} catch (error) {
		return {
			ok: false,
			content: error instanceof Error ? error.message : "That Google call failed.",
		}
	}
}

export const gmailSearchTool: AgentTool = {
	name: "gmail_search",
	description:
		"Search the connected Gmail mailbox and read the matching messages. Takes Gmail's own search syntax. Read only.",
	parameters: gmailSearchParameters,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = gmailSearchParameters.parse(args)

		return attempt(async () => {
			const list = (await callGoogle(context.workspaceId, {
				scope: GOOGLE_SCOPES.gmailRead,
				url: `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(input.query)}&maxResults=${input.limit}`,
			})) as { messages?: { id: string }[] }

			const ids = (list.messages ?? []).slice(0, input.limit).map((message) => message.id)
			const messages: RenderableMessage[] = []

			for (const id of ids) {
				const full = (await callGoogle(context.workspaceId, {
					scope: GOOGLE_SCOPES.gmailRead,
					url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
				})) as GmailMessage

				messages.push(toRenderableMessage(full))
			}

			return {
				ok: true,
				content: renderMessages(messages),
				metadata: { query: input.query, results: messages.length },
			}
		})
	},
}

export const gmailSendTool: AgentTool = {
	name: "gmail_send",
	description:
		"Send a plain-text email from the connected Gmail account. It goes out as that person, so say who it is from in the body when that matters.",
	parameters: gmailSendParameters,
	writes: true,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = gmailSendParameters.parse(args)

		return attempt(async () => {
			// RFC 2822, base64url. Gmail takes the whole message rather than fields,
			// which is why the headers are built here rather than passed.
			const raw = Buffer.from(
				[
					`To: ${input.to}`,
					`Subject: ${sanitiseHeader(input.subject)}`,
					"Content-Type: text/plain; charset=utf-8",
					"",
					input.body,
				].join("\r\n"),
			).toString("base64url")

			const sent = (await callGoogle(context.workspaceId, {
				scope: GOOGLE_SCOPES.gmailSend,
				method: "POST",
				url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
				body: { raw },
			})) as { id?: string }

			return {
				ok: true,
				content: `Sent to ${input.to}.`,
				metadata: { to: input.to, messageId: sent.id },
			}
		})
	},
}

export const driveSearchTool: AgentTool = {
	name: "drive_search",
	description:
		"Find files in the connected Google Drive by name or content. Returns names, ids and links — not the file contents.",
	parameters: driveSearchParameters,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = driveSearchParameters.parse(args)

		return attempt(async () => {
			// The quote escaping matters: a search term containing a single quote
			// would otherwise close Drive's query string and change what is asked.
			const term = input.query.replace(/'/g, "\\'")
			const query = encodeURIComponent(`fullText contains '${term}' and trashed = false`)

			const result = (await callGoogle(context.workspaceId, {
				scope: GOOGLE_SCOPES.driveRead,
				url: `https://www.googleapis.com/drive/v3/files?q=${query}&pageSize=${input.limit}&fields=files(id,name,mimeType,modifiedTime,webViewLink)`,
			})) as { files?: DriveFile[] }

			const files: RenderableFile[] = (result.files ?? []).map((file) => ({
				id: file.id ?? "",
				name: file.name ?? "(untitled)",
				mimeType: file.mimeType ?? "",
				modifiedTime: file.modifiedTime ?? "",
				link: file.webViewLink ?? "",
			}))

			return {
				ok: true,
				content: renderFiles(files),
				metadata: { query: input.query, results: files.length },
			}
		})
	},
}

export const calendarEventsTool: AgentTool = {
	name: "calendar_list_events",
	description:
		"List events from the connected Google Calendar over a date range. Read only — it cannot create or change anything.",
	parameters: calendarEventsParameters,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = calendarEventsParameters.parse(args)

		return attempt(async () => {
			const start = input.from ? new Date(`${input.from}T00:00:00Z`) : new Date()
			const end = new Date(start.getTime() + input.days * 86_400_000)

			const result = (await callGoogle(context.workspaceId, {
				scope: GOOGLE_SCOPES.calendarRead,
				url: `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${start.toISOString()}&timeMax=${end.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=${input.limit}`,
			})) as { items?: CalendarEvent[] }

			const events: RenderableEvent[] = (result.items ?? []).map((event) => ({
				summary: event.summary ?? "(no title)",
				// An all-day event carries `date` and a timed one carries `dateTime`.
				// Reporting one as the other loses the distinction somebody is asking
				// about when they ask what their day looks like.
				start: event.start?.dateTime ?? event.start?.date ?? "",
				end: event.end?.dateTime ?? event.end?.date ?? "",
				location: event.location ?? "",
				attendees: (event.attendees ?? []).map((person) => person.email ?? "").filter(Boolean),
			}))

			return {
				ok: true,
				content: renderEvents(events),
				metadata: { from: start.toISOString(), days: input.days, results: events.length },
			}
		})
	},
}

export const sheetsReadTool: AgentTool = {
	name: "sheets_read",
	description:
		"Read a range of cells from a Google Sheet the connected account can open. Give the spreadsheet id from its URL and an A1 range.",
	parameters: sheetsReadParameters,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = sheetsReadParameters.parse(args)

		return attempt(async () => {
			const result = (await callGoogle(context.workspaceId, {
				scope: GOOGLE_SCOPES.sheets,
				url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.range)}`,
			})) as { values?: string[][] }

			const rows = result.values ?? []
			return {
				ok: true,
				content: renderRows(input.range, rows),
				metadata: { range: input.range, rows: rows.length },
			}
		})
	},
}

export const sheetsAppendTool: AgentTool = {
	name: "sheets_append",
	description:
		"Append rows to a Google Sheet. The rows go after the last one with data — nothing is overwritten.",
	parameters: sheetsAppendParameters,
	writes: true,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = sheetsAppendParameters.parse(args)

		return attempt(async () => {
			// `RAW`, not `USER_ENTERED`. The latter makes Google parse each cell as if
			// somebody had typed it — so a value beginning with `=` becomes a formula
			// in the customer's own spreadsheet, which is formula injection written by
			// whatever text the model was working from.
			const result = (await callGoogle(context.workspaceId, {
				scope: GOOGLE_SCOPES.sheets,
				method: "POST",
				url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
				body: { values: input.values },
			})) as { updates?: { updatedRows?: number } }

			const written = result.updates?.updatedRows ?? input.values.length
			return {
				ok: true,
				content: `Appended ${written} ${written === 1 ? "row" : "rows"}.`,
				metadata: { range: input.range, rows: written },
			}
		})
	},
}

export const GOOGLE_TOOLS: AgentTool[] = [
	gmailSearchTool,
	gmailSendTool,
	driveSearchTool,
	calendarEventsTool,
	sheetsReadTool,
	sheetsAppendTool,
]

/**
 * A header cannot carry a newline.
 *
 * Without this a subject containing `\r\nBcc: someone@else` adds a recipient to
 * a message the model only meant to send to one person — header injection, in
 * the one tool here that sends mail as a real person.
 */
function sanitiseHeader(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim()
}

interface GmailMessage {
	payload?: {
		headers?: { name?: string; value?: string }[]
		body?: { data?: string }
		parts?: GmailPart[]
	}
	snippet?: string
}

interface GmailPart {
	mimeType?: string
	body?: { data?: string }
	parts?: GmailPart[]
}

interface DriveFile {
	id?: string
	name?: string
	mimeType?: string
	modifiedTime?: string
	webViewLink?: string
}

interface CalendarEvent {
	summary?: string
	location?: string
	start?: { date?: string; dateTime?: string }
	end?: { date?: string; dateTime?: string }
	attendees?: { email?: string }[]
}

function header(message: GmailMessage, name: string): string {
	const found = message.payload?.headers?.find(
		(entry) => entry.name?.toLowerCase() === name.toLowerCase(),
	)
	return found?.value ?? ""
}

/**
 * The plain-text body, or the snippet when there is none.
 *
 * `text/plain` is preferred over `text/html` deliberately: HTML would reach the
 * model full of markup it has to see past, and the parts of an email most likely
 * to be hostile are the ones a renderer hides.
 */
function firstTextPart(part: GmailPart | undefined): string | undefined {
	if (!part) return undefined
	if (part.mimeType === "text/plain" && part.body?.data) {
		return Buffer.from(part.body.data, "base64url").toString("utf8")
	}
	for (const child of part.parts ?? []) {
		const found = firstTextPart(child)
		if (found) return found
	}
	return undefined
}

function toRenderableMessage(message: GmailMessage): RenderableMessage {
	const direct = message.payload?.body?.data
		? Buffer.from(message.payload.body.data, "base64url").toString("utf8")
		: undefined

	return {
		from: header(message, "From"),
		to: header(message, "To"),
		subject: header(message, "Subject"),
		date: header(message, "Date"),
		body:
			firstTextPart({ mimeType: "", parts: message.payload?.parts }) ??
			direct ??
			message.snippet ??
			"",
	}
}
