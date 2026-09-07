import { z } from "zod"

/**
 * The graph an agent version may carry instead of a single prompt.
 *
 * Shape borrowed from RAGFlow's canvas DSL and simplified. Two departures worth
 * stating, both deliberate:
 *
 * - **Edges are the nodes' own `upstream` / `downstream` lists**, not a separate
 *   edge array. The engine only ever asks "what comes after this", and a
 *   separate list would be a second place for the same fact to be wrong.
 * - **`position` is presentation and the engine never reads it.** A graph that
 *   executes differently because someone dragged a box would be indefensible;
 *   the canvas owns the coordinates and nothing else.
 *
 * A version with no graph is a Phase 1 agent — one prompt, one answer — and that
 * stays true forever, so nothing built earlier breaks when this arrives.
 */
export const NODE_TYPES = [
	"begin",
	"llm",
	"knowledge_search",
	"agent",
	"categorize",
	"switch",
	"user_input",
	"message",
] as const

export type NodeType = (typeof NODE_TYPES)[number]

const positionSchema = z.object({ x: z.number(), y: z.number() })

/**
 * What a node does when it throws.
 *
 * The three options are the ones a flow actually needs and RAGFlow settled on:
 * try again, carry on with a stand-in value, or take a different branch. A
 * fourth — "fail the run" — is what happens with no policy at all.
 */
const errorPolicySchema = z.object({
	retries: z.number().int().min(0).max(3).default(0),
	/** Used as the node's output instead of failing the run. */
	defaultValue: z.string().max(2_000).nullable().default(null),
	/** Nodes to run instead of this one's normal downstream. */
	goto: z.array(z.string()).max(4).default([]),
})

const nodeSchema = z.object({
	type: z.enum(NODE_TYPES),
	/** What the canvas calls it. Also what a run's timeline shows. */
	label: z.string().trim().max(80).default(""),
	/** Per-type configuration, validated by the node itself when it runs. */
	params: z.record(z.string(), z.unknown()).default({}),
	upstream: z.array(z.string()).max(20).default([]),
	downstream: z.array(z.string()).max(20).default([]),
	position: positionSchema.nullable().default(null),
	onError: errorPolicySchema.nullable().default(null),
})

export const agentGraphSchema = z.object({
	nodes: z.record(z.string().min(1).max(64), nodeSchema),
})

export type GraphNode = z.infer<typeof nodeSchema>
export type AgentGraph = z.infer<typeof agentGraphSchema>
export type ErrorPolicy = z.infer<typeof errorPolicySchema>

/** The id of the one entry point. Fixed rather than searched for. */
export const BEGIN_NODE = "begin"

/**
 * What a node leaves behind for the ones after it.
 *
 * `text` is the common case and what a `{{node.text}}` reference resolves to.
 * `next` overrides the node's `downstream`, which is how a branch is taken —
 * the branching node decides, rather than the engine inspecting its params.
 */
export interface NodeOutput {
	text: string
	/** Extra values a reference can reach, e.g. `{{search.count}}`. */
	values?: Record<string, string>
	/** Set by branching nodes. Absent means "take my downstream". */
	next?: string[]
	/** Set by `user_input`: the run pauses and waits for these. */
	awaiting?: { prompt: string; fields: string[] }
}

/**
 * Structural checks that do not need a run.
 *
 * Done at publish time, because a graph with a dangling edge is a mistake
 * someone can fix while they are looking at it — and the same mistake found
 * mid-run is a failed run and a charged model call.
 */
export function validateGraph(graph: AgentGraph): string[] {
	const problems: string[] = []
	const ids = Object.keys(graph.nodes)

	if (!graph.nodes[BEGIN_NODE]) {
		problems.push("The graph needs a node called `begin`.")
	} else if (graph.nodes[BEGIN_NODE].type !== "begin") {
		problems.push("The node called `begin` must be of type `begin`.")
	}

	const begins = ids.filter((id) => graph.nodes[id]?.type === "begin")
	if (begins.length > 1) {
		problems.push("A graph has exactly one `begin` node.")
	}

	for (const [id, node] of Object.entries(graph.nodes)) {
		for (const target of node.downstream) {
			if (!graph.nodes[target]) {
				problems.push(`"${id}" points at "${target}", which is not in the graph.`)
			}
		}
		for (const source of node.upstream) {
			if (!graph.nodes[source]) {
				problems.push(`"${id}" lists "${source}" as an input, which is not in the graph.`)
			}
		}
		for (const target of node.onError?.goto ?? []) {
			if (!graph.nodes[target]) {
				problems.push(`"${id}" fails over to "${target}", which is not in the graph.`)
			}
		}
	}

	// A node nothing reaches never runs. That is almost always an edge someone
	// meant to draw, and silently ignoring it makes a flow that looks right and
	// is not.
	const orphans = ids.filter((id) => id !== BEGIN_NODE && graph.nodes[id]!.upstream.length === 0)
	if (orphans.length > 0) {
		problems.push(`Nothing leads to ${orphans.map((id) => `"${id}"`).join(", ")}.`)
	}

	return problems
}

/**
 * Resolves `{{...}}` references in a parameter.
 *
 * `{{sys.input}}` is what the run was asked to do; `{{nodeId.text}}` is what a
 * node produced. An unresolved reference becomes an empty string rather than
 * throwing: a half-configured node should produce a poor answer someone can see
 * and fix, not a failed run with a stack trace.
 */
export function resolveTemplate(
	template: string,
	values: Record<string, Record<string, string>>,
): string {
	return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, reference: string) => {
		const separator = reference.lastIndexOf(".")
		if (separator < 1) return ""
		const nodeId = reference.slice(0, separator)
		const field = reference.slice(separator + 1)
		return values[nodeId]?.[field] ?? ""
	})
}
