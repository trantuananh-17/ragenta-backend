/**
 * How an agent version names a third-party MCP tool.
 *
 * In its own module, importing nothing, because its test has to run in a check
 * job with no database: the service reaches the repository, which reaches
 * `db/client`, which validates the whole environment at import time. The same
 * rule `platform-usage.dto.ts` exists for, and the same mistake made twice would
 * be one too many.
 */

/**
 * A tool id an agent version can store: `mcp:<server-slug>:<tool-name>`.
 *
 * Three parts rather than two so the server is always explicit. Two servers can
 * and will both advertise a tool called `search`, and a version that recorded
 * only the tool name would silently start calling the other one the day somebody
 * adds a second server.
 */
const TOOL_ID_PATTERN = /^mcp:([a-z][a-z0-9-]{0,63}):([A-Za-z0-9_.-]{1,128})$/

export interface McpToolId {
	slug: string
	tool: string
}

export function parseMcpToolId(value: string): McpToolId | undefined {
	const match = TOOL_ID_PATTERN.exec(value)
	if (!match) return undefined
	return { slug: match[1]!, tool: match[2]! }
}

export function isMcpToolId(value: string): boolean {
	return parseMcpToolId(value) !== undefined
}

/**
 * The name the model sees, derived from the stored id.
 *
 * Colons are not accepted in a tool name by every provider, so the wire name
 * uses underscores. It is derived rather than stored, because two spellings of
 * one identity is how they drift.
 */
export function mcpWireName(id: McpToolId): string {
	return `mcp_${id.slug.replace(/-/g, "_")}_${id.tool}`
}
