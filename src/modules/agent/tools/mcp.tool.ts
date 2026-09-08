import { z } from "zod"

import type { McpToolSummary } from "../../../db/schema/mcp.schema"
import { mcpService, mcpWireName, parseMcpToolId } from "../../mcp/mcp.service"
import { renderMcpResult } from "./mcp-content"
import type { AgentTool, ToolContext, ToolResult } from "./types"

/**
 * A third-party MCP tool, as one of this runner's tools.
 *
 * The bridge is deliberately thin. What matters is what it does **not** carry
 * across: the model never names a server, never names a URL and never reaches a
 * server this workspace was not given. It chooses among ids that were resolved
 * from the version, which is the same rule `knowledge_search` follows about
 * knowledge bases (ADR-056).
 */
export function createMcpTool(toolId: string, summary: McpToolSummary): AgentTool | undefined {
	const parsed = parseMcpToolId(toolId)
	if (!parsed) return undefined

	return {
		name: mcpWireName(parsed),
		description: `${summary.description || summary.name} (provided by the ${parsed.slug} MCP server)`,
		/**
		 * The server's own JSON Schema, passed through.
		 *
		 * A `z.record` rather than a translation of it: rebuilding somebody else's
		 * schema in zod would mean this client disagreeing with the server about
		 * what its own tool accepts, and being confidently wrong about it. The
		 * arguments are validated by the server, which is the thing that knows.
		 * What we do enforce is the ceiling on how much can be sent.
		 */
		parameters: z.record(z.string(), z.unknown()),
		jsonSchema: summary.inputSchema,

		async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
			const payload =
				args && typeof args === "object" ? (args as Record<string, unknown>) : {}

			try {
				const outcome = await mcpService.call(
					context.workspaceId,
					parsed,
					payload,
					context.signal,
				)

				return {
					ok: outcome.ok,
					// Fenced. A third-party server's output is attacker-influenced text
					// in exactly the way a fetched web page is, and it arrives in the
					// position a tool result occupies — which a model reads attentively.
					content: renderMcpResult(parsed.slug, parsed.tool, outcome.text),
					metadata: { server: parsed.slug, tool: parsed.tool, ok: outcome.ok },
				}
			} catch (error) {
				// A failure the model should hear about rather than one that ends the
				// run: a server being down is a reason to try something else.
				return {
					ok: false,
					content:
						error instanceof Error
							? `The ${parsed.slug} server could not run ${parsed.tool}: ${error.message}`
							: `The ${parsed.slug} server could not run ${parsed.tool}.`,
					metadata: { server: parsed.slug, tool: parsed.tool, ok: false },
				}
			}
		},
	}
}
