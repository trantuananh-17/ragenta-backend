/**
 * What a tool *is*, with nothing that runs one.
 *
 * In its own module because `index.ts` reaches the MCP service to resolve
 * third-party tools, and that reaches the database — so anything importing the
 * id list would pull in `config/env` and fail in a check job with no
 * environment. `platform-usage.dto.ts` and `tool-id.ts` exist for the same
 * reason; this is the third time and the last one that should be needed.
 */

/**
 * The tools this deployment can run, and what a version may name.
 *
 * A stable id list rather than a free-form string: `agent_version.tools` stores
 * these ids, an unknown one is refused when the version is published, and the
 * set a run may call is built from the version — never from the request and
 * never from anything the model produced (ADR-029, `.claude/rules/security.md`).
 */
export const TOOL_IDS = [
	"knowledge_search",
	"web_search",
	"http_request",
	"api_call",
	"send_email",
	"save_document",
	"image_ocr",
	"image_vision",
	"speech_transcribe",
	"speech_synthesize",
	"excel_read",
	"excel_write",
	"browser_read",
	"memory_write",
	"memory_search",
	"gmail_search",
	"gmail_send",
	"drive_search",
	"calendar_list_events",
	"sheets_read",
	"sheets_append",
] as const
export type ToolId = (typeof TOOL_IDS)[number]

export function isToolId(value: string): value is ToolId {
	return (TOOL_IDS as readonly string[]).includes(value)
}

/**
 * What a version's tool list means, for the screen that offers it.
 *
 * `writes` and `requires` are here rather than only in the code because they are
 * what someone choosing tools actually needs to know: whether this will change
 * something out in the world, and whether it will work at all on this
 * deployment.
 */
export const TOOL_CATALOGUE: Record<
	ToolId,
	{
		title: string
		description: string
		writes: boolean
		/** An integration id that must exist and be enabled, or null. */
		requires: string | null
	}
> = {
	knowledge_search: {
		title: "Knowledge search",
		description:
			"Search the agent's own knowledge bases. The agent chooses when and what to search, and may search several times.",
		writes: false,
		requires: null,
	},
	web_search: {
		title: "Web search",
		description:
			"Search the public web and read the extracted text of the best results.",
		writes: false,
		requires: "tavily",
	},
	http_request: {
		title: "Fetch a URL",
		description:
			"Read a public web page or HTTP API. Private and internal addresses are blocked, and responses are capped.",
		writes: false,
		requires: null,
	},
	api_call: {
		title: "Call a connected system",
		description:
			"Call an external system through a connection an administrator configured. Each connection limits the methods and paths it allows.",
		writes: true,
		requires: null,
	},
	send_email: {
		title: "Send an email",
		description:
			"Send a plain-text email. Only addresses on the deployment's allowlist can be written to.",
		writes: true,
		requires: "email",
	},
	save_document: {
		title: "Save a document",
		description:
			"Write text back into one of the agent's knowledge bases, so later runs can search it.",
		writes: true,
		requires: null,
	},
	image_ocr: {
		title: "Read a document image",
		description:
			"Extract the text, tables and labelled values from an image attachment — a scan, a receipt, a form. Needs a vision-capable model, and re-uses an extraction the image already has.",
		writes: false,
		requires: null,
	},
	image_vision: {
		title: "Look at an image",
		description:
			"Answer a question about what an image attachment shows. Needs a vision-capable model configured for the workspace.",
		writes: false,
		requires: null,
	},
	speech_transcribe: {
		title: "Transcribe a recording",
		description:
			"Turn an audio attachment into text — a voice note, a recorded call, a meeting clip. Needs speech-to-text configured for the deployment, and re-uses a transcript the recording already has.",
		writes: false,
		requires: null,
	},
	speech_synthesize: {
		title: "Speak text aloud",
		description:
			"Generate speech from text and save it as a new audio attachment, returning its id. Needs text-to-speech configured for the deployment.",
		writes: false,
		requires: null,
	},
	excel_read: {
		title: "Read a spreadsheet",
		description:
			"Read an .xlsx attachment as rows the agent can quote and reason over. Long sheets are truncated, and the agent is told when they were.",
		writes: false,
		requires: null,
	},
	excel_write: {
		title: "Create a spreadsheet",
		description:
			"Build an .xlsx file from rows the agent produces and save it as a new file attachment, returning its id.",
		writes: false,
		requires: null,
	},
	browser_read: {
		title: "Open a page in a browser",
		description:
			"Render a page in a real browser and read it, for sites a plain fetch returns empty. Reading only — it cannot click or type. Needs a browser service configured for the deployment.",
		writes: false,
		requires: null,
	},
	memory_write: {
		title: "Remember something",
		description:
			"Keep one fact for future conversations. Only available on a version with memory turned on, and what it writes is only ever read back by this agent.",
		// It writes nothing outside Ragenta, but it does change what the agent will
		// say tomorrow — which is why it appears on the tool list rather than being
		// switched on invisibly with memory itself.
		writes: false,
		requires: null,
	},
	memory_search: {
		title: "Search what you remember",
		description:
			"Look through this agent's own memories. The most relevant are already in context at the start of a run; this is for something older or more specific.",
		writes: false,
		requires: null,
	},
	gmail_search: {
		title: "Search Gmail",
		description:
			"Search the connected Gmail mailbox and read the matching messages. Needs a Google account connected to this workspace.",
		writes: false,
		requires: null,
	},
	gmail_send: {
		title: "Send from Gmail",
		description:
			"Send a plain-text email as the connected Google account. It goes out as that person.",
		writes: true,
		requires: null,
	},
	drive_search: {
		title: "Search Google Drive",
		description:
			"Find files in the connected Drive by name or content. Returns names, ids and links, not contents.",
		writes: false,
		requires: null,
	},
	calendar_list_events: {
		title: "Read Google Calendar",
		description: "List events over a date range from the connected calendar. Read only.",
		writes: false,
		requires: null,
	},
	sheets_read: {
		title: "Read a Google Sheet",
		description: "Read a range of cells from a sheet the connected account can open.",
		writes: false,
		requires: null,
	},
	sheets_append: {
		title: "Append to a Google Sheet",
		description:
			"Add rows after the last one with data. Values are written literally, so a cell starting with = stays text rather than becoming a formula.",
		writes: true,
		requires: null,
	},
}

/** Whether a tool changes something outside Ragenta. */
export function toolWrites(id: string): boolean {
	return isToolId(id) ? TOOL_CATALOGUE[id].writes : false
}
