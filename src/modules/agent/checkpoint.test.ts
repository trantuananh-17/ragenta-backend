import { describe, expect, it } from "vitest"

import {
	MAX_NODE_EXECUTIONS,
	RUN_CHECKPOINT_VERSION,
	buildCheckpoint,
	chargeReference,
	nextRunnable,
	nextSeq,
	pendingNodes,
	readCheckpoint,
	remainingExecutions,
} from "./checkpoint"
import type { GraphState, RunCheckpoint } from "./checkpoint"
import { agentGraphSchema } from "./graph/types"

function graphState(overrides: Partial<GraphState> = {}): GraphState {
	return {
		completed: [],
		reached: ["begin"],
		values: {},
		pending: null,
		output: "",
		executions: 0,
		...overrides,
	}
}

function checkpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
	return buildCheckpoint({
		graph: null,
		loop: null,
		seq: 0,
		credits: 0,
		usage: { inputTokens: 0, outputTokens: 0 },
		output: "",
		...overrides,
	})
}

/** begin → search → answer, with a `switch` fanning out to two ends. */
const graph = agentGraphSchema.parse({
	nodes: {
		begin: { type: "begin", downstream: ["route"] },
		route: { type: "switch", upstream: ["begin"], downstream: ["short", "long"] },
		short: { type: "message", upstream: ["route"], downstream: ["done"] },
		long: { type: "llm", upstream: ["route"], downstream: ["done"] },
		done: { type: "message", upstream: ["short", "long"] },
	},
})

describe("nextSeq — the double-charge guard", () => {
	it("starts a fresh run at zero", () => {
		expect(nextSeq(null)).toBe(0)
	})

	it("continues a resumed run's numbering instead of restarting it", () => {
		expect(nextSeq(checkpoint({ seq: 7 }))).toBe(7)
	})

	it("gives replayed work the reference it already had", () => {
		// The attempt that died charged steps 0..4 and checkpointed at 3, so the
		// two calls after the checkpoint are replayed. They must land on the same
		// references, because `usage_ledger.reference` is unique and that is the
		// only thing standing between a resumed run and a second bill.
		const first = [0, 1, 2, 3, 4].map((seq) => chargeReference("run-1", seq))

		let seq = nextSeq(checkpoint({ seq: 3 }))
		const replayed = [chargeReference("run-1", seq++), chargeReference("run-1", seq++)]

		expect(replayed).toEqual([first[3], first[4]])
	})

	it("never reuses a reference across runs", () => {
		expect(chargeReference("run-a", 2)).not.toBe(chargeReference("run-b", 2))
	})

	it("keeps the reference format the ledger and the step row agree on", () => {
		expect(chargeReference("run-1", 4)).toBe("agent-run:run-1:step:4")
	})

	it("does not restart numbering when the checkpoint has spent credits but no graph", () => {
		// A tool-loop run: nothing structural is saved, but the numbering still is,
		// so a retry cannot hand round one the reference round one already used.
		expect(nextSeq(checkpoint({ seq: 12, credits: 40 }))).toBe(12)
	})
})

describe("readCheckpoint", () => {
	it("reads nothing out of a run that has not started", () => {
		expect(readCheckpoint({})).toBeNull()
		expect(readCheckpoint(null)).toBeNull()
		expect(readCheckpoint("not an object")).toBeNull()
		expect(readCheckpoint([])).toBeNull()
	})

	it("round-trips a checkpoint through the jsonb column", () => {
		const saved = checkpoint({
			graph: graphState({ completed: ["begin"], reached: ["begin", "route"], executions: 1 }),
			seq: 3,
			credits: 12.5,
			usage: { inputTokens: 100, outputTokens: 20 },
			output: "half an answer",
		})

		const read = readCheckpoint(JSON.parse(JSON.stringify(saved)))

		expect(read).toEqual(saved)
		expect(read?.version).toBe(RUN_CHECKPOINT_VERSION)
	})

	it("reads a flow paused before checkpoints existed", () => {
		// ADR-031 stored the graph state bare. A run that paused for a person may
		// have been waiting across this deploy.
		const legacy = {
			completed: ["begin"],
			reached: ["begin", "ask"],
			values: { begin: { text: "" } },
			pending: "ask",
			output: "",
		}

		const read = readCheckpoint(legacy)

		expect(read?.graph?.pending).toBe("ask")
		expect(read?.graph?.completed).toEqual(["begin"])
		// Nothing recorded the numbering, so it restarts — safe now only because
		// the step insert tolerates its unique index and the ledger refuses the
		// second charge.
		expect(read?.seq).toBe(0)
		expect(read?.graph?.executions).toBe(0)
	})

	it("reads a tool loop paused for approval before checkpoints existed", () => {
		const legacy = {
			loop: {
				messages: [{ role: "user", content: "email them" }],
				call: { id: "call-1", name: "send_email", arguments: "{}" },
			},
		}

		const read = readCheckpoint(legacy)

		expect(read?.loop?.call.name).toBe("send_email")
		expect(read?.graph).toBeNull()
	})

	it("treats a shape it cannot understand as no checkpoint", () => {
		expect(readCheckpoint({ version: 1, seq: "three" })).toBeNull()
		expect(readCheckpoint({ something: "else" })).toBeNull()
	})

	it("refuses a negative step number rather than resuming below it", () => {
		expect(readCheckpoint({ version: 1, seq: -1 })).toBeNull()
	})
})

describe("pendingNodes", () => {
	it("starts a fresh run at the begin node", () => {
		expect(pendingNodes(graph, null)).toEqual(["begin"])
	})

	it("skips what a previous attempt already finished", () => {
		const state = graphState({
			completed: ["begin", "route", "long"],
			reached: ["begin", "route", "long", "done"],
			executions: 3,
		})

		expect(pendingNodes(graph, checkpoint({ graph: state }))).toEqual(["done"])
	})

	it("never lists a branch nobody took", () => {
		// `route` sent the run down `long` only, so `short` was never reached and
		// is not waiting to run — this is the frontier, not a topological sort.
		const state = graphState({
			completed: ["begin", "route"],
			reached: ["begin", "route", "long"],
		})

		expect(pendingNodes(graph, checkpoint({ graph: state }))).toEqual(["long"])
	})

	it("re-runs the node a person was asked at", () => {
		const state = graphState({
			completed: ["begin", "route", "long"],
			reached: ["begin", "route", "long"],
			pending: "long",
		})

		expect(pendingNodes(graph, checkpoint({ graph: state }))).toEqual(["long"])
	})

	it("ignores a node id the graph no longer has", () => {
		const state = graphState({ completed: ["begin"], reached: ["begin", "removed"] })

		expect(pendingNodes(graph, checkpoint({ graph: state }))).toEqual([])
	})
})

describe("nextRunnable", () => {
	it("waits for a reached upstream that has not finished", () => {
		const reached = new Set(["begin", "route", "long", "done"])
		const completed = new Set(["begin", "route"])

		expect(nextRunnable(graph, reached, completed)).toBe("long")
	})

	it("runs the join once the branch that was taken is done", () => {
		const reached = new Set(["begin", "route", "long", "done"])
		const completed = new Set(["begin", "route", "long"])

		// `short` is an upstream of `done` and will never finish, because the run
		// never went that way. Waiting for it would deadlock the flow.
		expect(nextRunnable(graph, reached, completed)).toBe("done")
	})

	it("returns nothing when everything reached is finished", () => {
		const reached = new Set(["begin", "route"])
		const completed = new Set(["begin", "route"])

		expect(nextRunnable(graph, reached, completed)).toBeUndefined()
	})
})

describe("remainingExecutions", () => {
	it("gives a fresh run the whole budget", () => {
		expect(remainingExecutions(null)).toBe(MAX_NODE_EXECUTIONS)
	})

	it("carries the budget across attempts", () => {
		// A retry that reset this would let a looping flow bill forever, one
		// attempt at a time.
		const state = graphState({ executions: MAX_NODE_EXECUTIONS - 2 })

		expect(remainingExecutions(checkpoint({ graph: state }))).toBe(2)
	})

	it("never goes negative", () => {
		const state = graphState({ executions: MAX_NODE_EXECUTIONS + 5 })

		expect(remainingExecutions(checkpoint({ graph: state }))).toBe(0)
	})
})
