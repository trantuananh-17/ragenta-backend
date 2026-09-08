import { z } from "zod"

import { safeFetch } from "../modules/agent/tools/safe-fetch"
import { ValidationError } from "../shared/errors"
import { logger } from "../shared/logger"

const log = logger.child({ component: "mcp" })

/**
 * An MCP client, over `fetch` and with no SDK.
 *
 * The same decision `src/ai/clients/` makes about provider APIs, for the same
 * reasons: MCP is JSON-RPC 2.0 over HTTP and the wire format is short enough to
 * read. The official SDK also ships a stdio transport that spawns a child
 * process, which is precisely the capability this deployment must not have
 * anywhere near the API container (ADR-056).
 *
 * **Every request goes through `safeFetch`.** An MCP server's URL is typed in by
 * a customer, so it is an SSRF surface exactly like `http_request` — the address
 * checks, the redirect re-pinning and the credential-stripping across origins
 * all apply, and none of them is reimplemented here.
 */

const PROTOCOL_VERSION = "2025-06-18"
const CLIENT_INFO = { name: "ragenta", version: "1" }

/** One tool as the server describes it. */
export const mcpToolSchema = z.object({
	name: z.string().min(1).max(128),
	description: z.string().max(4_000).default(""),
	inputSchema: z.record(z.string(), z.unknown()).default({}),
})

export type McpTool = z.infer<typeof mcpToolSchema>

const toolsListResult = z.object({ tools: z.array(mcpToolSchema).max(500) })

/**
 * A tool result. `content` is a list of typed parts; only text is read.
 *
 * An image or a resource part is named rather than rendered: this reaches a
 * model as a tool result, which is text, and silently dropping a part would let
 * a tool appear to have answered when most of its answer went nowhere.
 */
const toolCallResult = z.object({
	content: z
		.array(
			z.object({
				type: z.string(),
				text: z.string().optional(),
			}),
		)
		.default([]),
	isError: z.boolean().default(false),
})

const rpcResponse = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.union([z.string(), z.number()]).nullable().optional(),
	result: z.unknown().optional(),
	error: z
		.object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
		.optional(),
})

export interface McpEndpoint {
	url: string
	/** Already decrypted. Never logged, never returned. */
	secret?: string | null
	authHeader?: string
	authPrefix?: string
}

let nextId = 1

/**
 * **Stateless servers only, and this is a real limitation rather than an
 * oversight.** A Streamable HTTP server may hand back an `Mcp-Session-Id` header
 * on `initialize` and require it on every later request; `safeFetch` returns a
 * body and a status and no headers, because it exists to make an *untrusted*
 * request safely and header plumbing was never needed. A server that requires a
 * session will refuse `tools/list` with its own message, which is at least
 * legible. Widening `safeFetch` to return headers is the fix when one of those
 * turns up — done then, with a reason, rather than speculatively now (ADR-056).
 */
async function call(
	endpoint: McpEndpoint,
	method: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		// Streamable HTTP: a server may answer with either, and the spec requires
		// a client to accept both.
		accept: "application/json, text/event-stream",
		"mcp-protocol-version": PROTOCOL_VERSION,
	}
	if (endpoint.secret) {
		headers[endpoint.authHeader?.toLowerCase() || "authorization"] =
			`${endpoint.authPrefix ?? "Bearer "}${endpoint.secret}`
	}

	const response = await safeFetch(
		endpoint.url,
		{
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
		},
		signal,
	)

	if (response.status >= 400) {
		throw new ValidationError(
			`The MCP server answered ${response.status} to ${method}.`,
		)
	}

	const payload = parseBody(response.body, response.contentType)
	const parsed = rpcResponse.safeParse(payload)
	if (!parsed.success) {
		throw new ValidationError(`The MCP server's answer to ${method} was not JSON-RPC.`)
	}
	if (parsed.data.error) {
		// The far side's own message, which is what makes a misconfiguration
		// diagnosable. It describes the request, not the credential.
		throw new ValidationError(`The MCP server refused ${method}: ${parsed.data.error.message}`)
	}

	return parsed.data.result
}

/**
 * A Streamable HTTP server may answer a POST with `text/event-stream` instead of
 * JSON. The response carries one JSON-RPC message per `data:` line; the last one
 * is the answer to the request just made.
 */
function parseBody(body: string, contentType: string): unknown {
	if (!contentType.includes("text/event-stream")) {
		try {
			return JSON.parse(body) as unknown
		} catch {
			throw new ValidationError("The MCP server did not answer with JSON.")
		}
	}

	const frames = body
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.filter(Boolean)

	const last = frames[frames.length - 1]
	if (!last) throw new ValidationError("The MCP server sent an empty event stream.")

	try {
		return JSON.parse(last) as unknown
	} catch {
		throw new ValidationError("The MCP server sent an event that was not JSON.")
	}
}

/**
 * Handshake, then list the tools.
 *
 * `initialize` is not skipped even though `tools/list` often works without it:
 * the handshake is where the server states its protocol version, and a server
 * that refuses the version we speak should say so before we start calling its
 * tools rather than midway through a run.
 */
export async function listTools(
	endpoint: McpEndpoint,
	signal?: AbortSignal,
): Promise<McpTool[]> {
	await call(
		endpoint,
		"initialize",
		{ protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
		signal,
	)

	const result = await call(endpoint, "tools/list", {}, signal)
	const parsed = toolsListResult.safeParse(result)
	if (!parsed.success) {
		throw new ValidationError("The MCP server's tool list was not in the expected shape.")
	}

	log.debug("mcp.tools_listed", { count: parsed.data.tools.length })
	return parsed.data.tools
}

export interface McpCallOutcome {
	ok: boolean
	text: string
}

/**
 * Calls one tool.
 *
 * A tool that reports an error is **not** an exception: the model should be told
 * so it can try something else, exactly as every built-in tool here does. Only a
 * transport or protocol failure throws.
 */
export async function callTool(
	endpoint: McpEndpoint,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<McpCallOutcome> {
	const result = await call(endpoint, "tools/call", { name, arguments: args }, signal)

	const parsed = toolCallResult.safeParse(result)
	if (!parsed.success) {
		throw new ValidationError(`${name} answered in a shape this client cannot read.`)
	}

	const parts = parsed.data.content.map((part) =>
		part.type === "text" && part.text !== undefined
			? part.text
			: `[the server returned a ${part.type} part, which cannot be read as text]`,
	)

	return {
		ok: !parsed.data.isError,
		text: parts.join("\n\n").trim() || "The tool returned nothing.",
	}
}
