import { isAppError } from "../../../shared/errors"
import { logger } from "../../../shared/logger"
import { MAX_NODE_EXECUTIONS, nextRunnable } from "../checkpoint"
import type { GraphState } from "../checkpoint"
import { NODE_IMPLEMENTATIONS } from "./nodes"
import type { NodeContext, NodeEvent } from "./nodes"
import type { AgentGraph, NodeOutput } from "./types"
import { BEGIN_NODE } from "./types"

const log = logger.child({ module: "agent.graph" })

/**
 * Everything a paused or interrupted run needs to carry on later, and nothing
 * else. Defined with the rest of the checkpoint in `../checkpoint.ts`, because
 * the state the engine yields and the state a resumed run is handed have to be
 * one type or they will drift.
 */
export type { GraphState }

export type GraphEvent =
	| { type: "node_started"; nodeId: string; label: string; nodeType: string }
	| { type: "node_finished"; nodeId: string; label: string; ok: boolean }
	| { type: "delta"; text: string }
	| { type: "tool_started"; name: string; arguments: string }
	| { type: "tool_finished"; name: string; ok: boolean; summary: string }
	| { type: "citations" }
	/**
	 * A node boundary the run can be picked up from. The caller persists `state`
	 * and everything before it is settled: a crash, a deploy or a timeout after
	 * this point costs the node that was in flight, not the whole run.
	 */
	| { type: "checkpoint"; state: GraphState }
	/** The run is waiting for a person. The caller saves `state` and returns. */
	| {
			type: "awaiting_input"
			nodeId: string
			prompt: string
			fields: string[]
			state: GraphState
		}
	/** Cancelled between nodes, with everything finished so far kept. */
	| { type: "stopped"; state: GraphState }
	| { type: "finished"; output: string; state: GraphState }
	| { type: "failed"; message: string; state: GraphState }

export interface RunGraphOptions {
	graph: AgentGraph
	context: NodeContext
	/** Fresh run, or the state a paused or interrupted one left behind. */
	state?: GraphState | null
	/** The run's input, reachable as `{{sys.input}}`. */
	input: string
	isStopped?: () => Promise<boolean>
}

/**
 * Executes a graph, node by node.
 *
 * **The frontier model, not a topological sort.** A node becomes runnable when
 * every upstream that was actually *reached* has finished — so a branch nobody
 * took never blocks the node after the join, which is exactly what a
 * topological sort gets wrong about conditional flows.
 *
 * **One node at a time.** RAGFlow runs its frontier concurrently; this does not,
 * because the two branches of a diamond both charging credits and appending run
 * steps concurrently would make the step numbering — which the usage reference
 * is built from — depend on which provider answered first. Sequential is slower
 * on a wide graph and correct on every graph. Worth revisiting when a real one
 * is wide enough for it to matter.
 *
 * **The node boundary is the checkpoint.** A node either finishes or it does
 * not; there is no half-finished node to resume into. So the engine yields a
 * `checkpoint` after each one and the caller writes it, which is what makes a
 * crash cost one node rather than the run.
 */
export async function* runGraph(
	options: RunGraphOptions,
): AsyncGenerator<GraphEvent, void> {
	const { graph, context } = options

	const completed = new Set(options.state?.completed ?? [])
	const reached = new Set(options.state?.reached ?? [BEGIN_NODE])
	const values: Record<string, Record<string, string>> = {
		...(options.state?.values ?? {}),
		sys: { input: options.input },
	}
	context.values = values

	let output = options.state?.output ?? ""
	// Carried across attempts, not counted per attempt: a retry that reset the
	// budget would hand a looping flow an unbounded bill in instalments.
	let executions = options.state?.executions ?? 0

	const snapshot = (pending: string | null): GraphState => ({
		completed: [...completed],
		reached: [...reached],
		values,
		pending,
		output,
		executions,
	})

	// A resumed run re-executes the node it stopped at. That node finds its
	// answers already in `values` and passes straight through — which is what
	// keeps resuming a re-run of the same graph rather than a second code path.
	if (options.state?.pending) completed.delete(options.state.pending)

	while (executions < MAX_NODE_EXECUTIONS) {
		const nodeId = nextRunnable(graph, reached, completed)
		if (!nodeId) break

		const node = graph.nodes[nodeId]
		if (!node) {
			completed.add(nodeId)
			continue
		}

		// Between nodes, never inside one. Stopping mid-node would throw away a
		// provider call that has already been paid for, which is the mistake
		// ADR-028 exists to prevent.
		if (options.isStopped && (await options.isStopped())) {
			yield { type: "stopped", state: snapshot(null) }
			return
		}

		executions += 1
		const label = node.label || nodeId
		yield { type: "node_started", nodeId, label, nodeType: node.type }

		let result: NodeOutput
		try {
			result = yield* execute(context, graph, nodeId)
		} catch (error) {
			const message = isAppError(error)
				? error.message
				: `The "${label}" step failed.`
			log.error("agent.node_failed", error, { runId: context.runId, nodeId })

			const policy = node.onError
			if (policy?.defaultValue !== null && policy?.defaultValue !== undefined) {
				result = { text: policy.defaultValue }
			} else if (policy?.goto.length) {
				result = { text: "", next: policy.goto }
			} else {
				yield { type: "node_finished", nodeId, label, ok: false }
				yield { type: "failed", message, state: snapshot(null) }
				return
			}
			yield { type: "node_finished", nodeId, label, ok: false }
			markDone(nodeId, node, result)
			yield { type: "checkpoint", state: snapshot(null) }
			continue
		}

		if (result.awaiting) {
			// Not an error and not a failure: the run has done everything it can
			// until a person answers.
			yield {
				type: "awaiting_input",
				nodeId,
				prompt: result.awaiting.prompt,
				fields: result.awaiting.fields,
				state: snapshot(nodeId),
			}
			return
		}

		yield { type: "node_finished", nodeId, label, ok: true }
		markDone(nodeId, node, result)
		yield { type: "checkpoint", state: snapshot(null) }
	}

	if (executions >= MAX_NODE_EXECUTIONS) {
		yield {
			type: "failed",
			message: `This flow ran ${MAX_NODE_EXECUTIONS} steps without finishing, which usually means two nodes point at each other.`,
			state: snapshot(null),
		}
		return
	}

	yield { type: "finished", output, state: snapshot(null) }

	function markDone(id: string, node: AgentGraph["nodes"][string], result: NodeOutput) {
		completed.add(id)
		values[id] = { text: result.text, ...(result.values ?? {}) }
		// The last node to produce text is the run's answer. A flow ending in a
		// `message` node therefore answers with that message, which is what the
		// node is for.
		if (result.text) output = result.text
		for (const target of result.next ?? node.downstream) reached.add(target)
	}
}

/** Runs one node, forwarding its events and retrying it if its policy says to. */
async function* execute(
	context: NodeContext,
	graph: AgentGraph,
	nodeId: string,
): AsyncGenerator<GraphEvent, NodeOutput> {
	const node = graph.nodes[nodeId]!
	const implementation = NODE_IMPLEMENTATIONS[node.type]
	const attempts = (node.onError?.retries ?? 0) + 1

	let lastError: unknown
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const iterator = implementation.execute(context, node, nodeId)
			let step = await iterator.next()
			while (!step.done) {
				yield forward(step.value)
				step = await iterator.next()
			}
			return step.value
		} catch (error) {
			lastError = error
			// A retry re-runs the node from the start, including any provider call
			// it already made and was already charged for. That is the honest cost
			// of a retry and why the ceiling is three.
			log.warn("agent.node_retry", { runId: context.runId, nodeId, attempt })
		}
	}

	throw lastError
}

function forward(event: NodeEvent): GraphEvent {
	return event
}
