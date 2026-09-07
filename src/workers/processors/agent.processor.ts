import type { Job } from "bullmq"

import { agentRunner } from "../../modules/agent/runner"
import { JOB_RUN_AGENT, runAgentPayload } from "../../queue/agent.jobs"
import type { RunAgentPayload } from "../../queue/agent.jobs"
import { logger } from "../../shared/logger"

const log = logger.child({ processor: "agent" })

/**
 * Runs an agent in the worker instead of inside an HTTP request.
 *
 * The events are drained and dropped on purpose. Every one of them has already
 * been written to `agent_run_step` and `agent_run` by the runner, and the client
 * reads those back — there is no Redis-to-SSE relay, which ADR-029 rejected
 * because it buys a live stream for a run nobody is necessarily watching at the
 * cost of a second delivery path for the same facts.
 */
async function runAgent(payload: RunAgentPayload) {
	const prepared = await agentRunner.pickUp(payload.workspaceId, payload.runId)
	if (!prepared) {
		// Finished, cancelled, or waiting on a person. A job runs more than once
		// and the repeat must do nothing.
		log.info("agent.run.skipped", { runId: payload.runId })
		return { runId: payload.runId, skipped: true }
	}

	let status = "failed"
	for await (const event of agentRunner.stream(payload.workspaceId, prepared)) {
		if (event.type === "done") status = event.status
	}

	log.info("agent.run.processed", {
		runId: payload.runId,
		status,
		attempts: prepared.run.attempts + 1,
	})

	// A run that failed is a recorded outcome, not a failed job: throwing here
	// would have BullMQ retry a refusal — no credits, a model that no longer
	// exists — three more times against the same wall. A retry is a decision,
	// and it has a route. What does throw is the unexpected: the runner could
	// not read the run at all, or the process is broken.
	return { runId: payload.runId, status }
}

export async function processAgentJob(job: Job) {
	switch (job.name) {
		case JOB_RUN_AGENT:
			return runAgent(runAgentPayload.parse(job.data))
		default:
			// An unknown name is a deploy mismatch, not a transient fault.
			throw new Error(`Unknown agent job: ${job.name}`)
	}
}
