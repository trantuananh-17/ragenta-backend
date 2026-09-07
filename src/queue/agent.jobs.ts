import { z } from "zod"

import { QUEUE_AGENT, getQueue } from "./queues"

export const JOB_RUN_AGENT = "agent.run" as const

/**
 * Ids and nothing else. Which version, what the input was, how far the run got —
 * all of it is on the run row, read when the job runs, so a job that sat in the
 * queue through a deploy acts on what is true afterwards rather than on a
 * snapshot taken when it was queued.
 */
export const runAgentPayload = z.object({
	workspaceId: z.string().min(1),
	runId: z.string().min(1),
})

export type RunAgentPayload = z.infer<typeof runAgentPayload>

/**
 * Queues one attempt at a run.
 *
 * The job id names the attempt, not the run: enqueueing the same attempt twice
 * adds nothing, while a deliberate retry is a different attempt and does run.
 * Repeating an attempt is safe anyway — the processor re-reads the run, skips
 * one that has already finished, and resumes from the checkpoint, where the
 * preserved step numbering makes the replayed calls free rather than billed a
 * second time.
 */
export async function enqueueAgentRun(payload: RunAgentPayload, attempt: number) {
	await getQueue(QUEUE_AGENT).add(JOB_RUN_AGENT, payload, {
		jobId: `agent-run:${payload.runId}:${attempt}`,
		// Fewer than the default five: every attempt that gets as far as the model
		// costs a provider call, and a run that failed twice for the same reason
		// will fail a third time. A person can retry it from the last checkpoint.
		attempts: 3,
	})
}
