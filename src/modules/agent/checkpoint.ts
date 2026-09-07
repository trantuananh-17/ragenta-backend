import { z } from "zod"

import type { ChatMessage } from "../../ai/clients"
import type { AgentGraph } from "./graph/types"
import { BEGIN_NODE } from "./graph/types"

/**
 * Where a run got to, so the next attempt carries on instead of starting again.
 *
 * **Stored on `agent_run.state`, not in a table of its own.** Only the latest
 * checkpoint is ever read — resuming means "carry on from the newest" and never
 * "replay the third one" — so a table would be an append-only log nothing
 * queries, one insert per node on the hot path, and, worse, a second place that
 * answers "how far did this run get". The run row already answers that for a
 * paused flow (ADR-031); two answers that can disagree is exactly how a run gets
 * billed twice. One row, updated in place, at node boundaries.
 *
 * **Values only, as ADR-031 requires.** A run waiting on a person may wait days
 * and across a deploy, and a crashed one is resumed by a different process, so
 * nothing that cannot survive a restart belongs here: no provider connection,
 * no open stream, no half-built prompt.
 *
 * **`seq` is the part that matters.** `usage_ledger.reference` is
 * `agent-run:{runId}:step:{seq}` and carries a unique index, so replaying work
 * under the *same* seq is refused by the database and replaying it under a fresh
 * one is billed again. Preserving `seq` across attempts is therefore the whole
 * double-charge guard, and `nextSeq` is the only place it is decided.
 */

/** Bumped when the stored shape changes in a way `readCheckpoint` must branch on. */
export const RUN_CHECKPOINT_VERSION = 1

/**
 * How many nodes one run may execute — across every attempt, which is why it is
 * carried in the checkpoint rather than counted per attempt.
 *
 * A graph is a DAG in the ordinary case, but `onError.goto` points wherever it
 * is told and a canvas will eventually let someone draw a cycle. Counting per
 * attempt would hand a looping flow a fresh budget every time it was retried,
 * which is the same unbounded bill with more steps in it.
 */
export const MAX_NODE_EXECUTIONS = 50

/**
 * The wall clock one attempt gets before it is stopped and checkpointed.
 *
 * Not a cost bound — the credit ceiling and `MAX_NODE_EXECUTIONS` are that. This
 * is the bound on a run that is not spending anything either: a provider that
 * never answers, a tool waiting on a host that will not close the connection. A
 * timed-out run keeps its checkpoint and can be retried.
 */
export const RUN_TIMEOUT_MS = 15 * 60_000

/** A run that may be picked up by a worker attempt. */
export const PICKUP_STATUSES = ["pending", "running"] as const

/** A run a person may ask to run again from its last checkpoint. */
export const RETRYABLE_STATUSES = ["failed", "stopped"] as const

const pendingCallSchema = z.object({
	id: z.string(),
	name: z.string(),
	arguments: z.string(),
})

/**
 * A paused tool loop (ADR-032): the conversation so far and the write it stopped
 * in front of.
 *
 * The messages are not re-validated field by field. They were written by this
 * process into a column only this process writes, so what is worth checking here
 * is the envelope — that state written by an older deploy still parses — not the
 * provider message shape, which already has one definition.
 */
const loopPauseSchema = z.object({
	messages: z.array(z.custom<ChatMessage>()),
	call: pendingCallSchema,
})

/** The frontier's progress: which nodes finished, and what they produced. */
const graphStateSchema = z.object({
	completed: z.array(z.string()).default([]),
	reached: z.array(z.string()).default([]),
	values: z.record(z.string(), z.record(z.string(), z.string())).default({}),
	/** The `user_input` node the run stopped at, if any. */
	pending: z.string().nullable().default(null),
	output: z.string().default(""),
	/** Nodes executed so far, across every attempt of this run. */
	executions: z.number().int().min(0).default(0),
})

const usageSchema = z.object({
	inputTokens: z.number().int().min(0),
	outputTokens: z.number().int().min(0),
})

const runCheckpointSchema = z.object({
	version: z.literal(RUN_CHECKPOINT_VERSION),
	graph: graphStateSchema.nullable().default(null),
	loop: loopPauseSchema.nullable().default(null),
	/** The next unused step number. See the note on this file. */
	seq: z.number().int().min(0),
	/** Credits this run has already spent, so a ceiling is not reset by a resume. */
	credits: z.number().min(0).default(0),
	usage: usageSchema.default({ inputTokens: 0, outputTokens: 0 }),
	output: z.string().default(""),
})

export type PendingCall = z.infer<typeof pendingCallSchema>
export type LoopPause = z.infer<typeof loopPauseSchema>
export type GraphState = z.infer<typeof graphStateSchema>
export type RunCheckpoint = z.infer<typeof runCheckpointSchema>

export function buildCheckpoint(input: {
	graph: GraphState | null
	loop: LoopPause | null
	seq: number
	credits: number
	usage: { inputTokens: number; outputTokens: number }
	output: string
}): RunCheckpoint {
	return {
		version: RUN_CHECKPOINT_VERSION,
		graph: input.graph,
		loop: input.loop,
		seq: input.seq,
		credits: input.credits,
		usage: input.usage,
		output: input.output,
	}
}

/**
 * Reads what a previous attempt left on `agent_run.state`.
 *
 * Tolerant of two older shapes on purpose. `agent_run.state` is a boundary — it
 * was written by whatever version of this code was deployed when the run paused,
 * and a run waiting on a person outlives deploys — so a state this build does
 * not recognise reads as "no checkpoint" and the run starts over, which is worse
 * than resuming and better than throwing.
 */
export function readCheckpoint(state: unknown): RunCheckpoint | null {
	if (state === null || typeof state !== "object" || Array.isArray(state)) return null
	const record = state as Record<string, unknown>
	if (Object.keys(record).length === 0) return null

	if (record.version === RUN_CHECKPOINT_VERSION) {
		const parsed = runCheckpointSchema.safeParse(record)
		return parsed.success ? parsed.data : null
	}

	// Written before checkpoints existed (ADR-031): the column held either a
	// graph's values or a paused tool loop and nothing else. Read rather than
	// discarded, so a run that paused before this deploy still resumes.
	const graph = Array.isArray(record.completed) ? graphStateSchema.safeParse(record) : null
	const loop = record.loop === undefined ? null : loopPauseSchema.safeParse(record.loop)
	if (!graph?.success && !loop?.success) return null

	const graphState = graph?.success ? graph.data : null
	return {
		version: RUN_CHECKPOINT_VERSION,
		graph: graphState,
		loop: loop?.success ? loop.data : null,
		// Nothing recorded how far the step numbering had got, and zero is what
		// the old code restarted from. Replaying those numbers is now a no-op
		// rather than a crash, because the step insert tolerates its own unique
		// index and the ledger refuses the second charge.
		seq: 0,
		credits: 0,
		usage: { inputTokens: 0, outputTokens: 0 },
		output: graphState?.output ?? "",
	}
}

/**
 * The step number the next charge takes — the double-charge guard.
 *
 * A resumed or retried attempt continues the numbering instead of restarting it,
 * so work that is replayed lands on the reference it already had and
 * `usage_ledger`'s unique index turns the second charge into nothing. Restarting
 * at zero would give the same work a fresh reference, and the database would
 * have no way to tell that it had already been paid for.
 */
export function nextSeq(checkpoint: RunCheckpoint | null): number {
	return checkpoint?.seq ?? 0
}

/** The `usage_ledger.reference` for one step. One definition, so replay matches. */
export function chargeReference(runId: string, seq: number): string {
	return `agent-run:${runId}:step:${seq}`
}

/**
 * The next node that can run: reached, not yet done, and with every reached
 * upstream finished.
 *
 * The "reached" qualifier is the whole trick. A join whose two inputs are the
 * two sides of a `switch` would never run if it waited for both, because only
 * one side is ever taken.
 */
export function nextRunnable(
	graph: AgentGraph,
	reached: Set<string>,
	completed: Set<string>,
): string | undefined {
	for (const id of reached) {
		if (completed.has(id)) continue
		const node = graph.nodes[id]
		if (!node) continue

		const blocked = node.upstream.some(
			(source) => reached.has(source) && !completed.has(source),
		)
		if (!blocked) return id
	}
	return undefined
}

/**
 * Which nodes a resumed attempt still has to run. Everything already completed
 * is skipped, which is what keeps a retry from paying for the same model call
 * twice in the first place — the reference dedupe is the backstop beneath it.
 */
export function pendingNodes(
	graph: AgentGraph,
	checkpoint: RunCheckpoint | null,
): string[] {
	const state = checkpoint?.graph ?? null
	const completed = new Set(state?.completed ?? [])
	const reached = new Set(state?.reached ?? [BEGIN_NODE])

	// A paused run re-executes the node it stopped at: that node finds its
	// answers already in `values` and passes straight through, which is what
	// keeps resuming a re-run of the same graph rather than a second code path.
	if (state?.pending) completed.delete(state.pending)

	return [...reached].filter((id) => !completed.has(id) && graph.nodes[id] !== undefined)
}

/** What is left of the run-wide node budget. Never negative. */
export function remainingExecutions(
	checkpoint: RunCheckpoint | null,
	limit = MAX_NODE_EXECUTIONS,
): number {
	return Math.max(limit - (checkpoint?.graph?.executions ?? 0), 0)
}
