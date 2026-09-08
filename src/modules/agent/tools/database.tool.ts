import { datasourceService } from "../../datasource/datasource.service"
import { databaseQueryParameters, renderRows } from "./database-content"
import type { AgentTool, ToolContext, ToolResult } from "./types"

/**
 * The one way an agent reaches a customer's database.
 *
 * The model supplies a **query name and parameters** — never SQL. The statement
 * behind that name was written or approved by a person, and the connection runs
 * it in a read-only transaction (ADR-064). There is no argument this tool takes
 * that could widen what it can read.
 *
 * The tool's description carries the list of approved queries, built when the
 * run starts: a model can only call what it has been told about, and telling it
 * is the same act as approving.
 */
export function createDatabaseTool(
	queries: { name: string; description: string; parameters: { name: string; type: string }[] }[],
): AgentTool {
	const catalogue = queries
		.map(
			(query) =>
				`- ${query.name}(${query.parameters.map((p) => `${p.name}: ${p.type}`).join(", ")}) — ${query.description}`,
		)
		.join("\n")

	return {
		name: "database_query",
		description: [
			"Look something up in this business's own database by running one of the approved queries below. You cannot write SQL; you choose a query by name and supply its parameters.",
			"",
			"Available queries:",
			catalogue || "(none — this agent has no approved queries)",
		].join("\n"),
		parameters: databaseQueryParameters,

		async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
			const input = databaseQueryParameters.parse(args)

			try {
				const { query, outcome } = await datasourceService.runNamed(
					context.workspaceId,
					input.query,
					input.parameters,
				)

				return {
					ok: true,
					content: renderRows(query.name, outcome.columns, outcome.rows, outcome.truncated),
					metadata: {
						query: query.name,
						rows: outcome.rows.length,
						durationMs: outcome.durationMs,
					},
				}
			} catch (error) {
				// A failure the model should hear about: a wrong parameter is
				// something it can correct on the next turn.
				return {
					ok: false,
					content:
						error instanceof Error ? error.message : `${input.query} could not be run.`,
					metadata: { query: input.query, ok: false },
				}
			}
		},
	}
}
