import { z } from "zod"

import { QUEUE_BILLING, getQueue } from "../queue/queues"
import { monthKey } from "../shared/id"

export const JOB_SCAN_PLAN_REFILLS = "billing.scan-plan-refills" as const
export const JOB_REFILL_PLAN_CREDITS = "billing.refill-plan-credits" as const
export const JOB_SCAN_AUTO_RELOAD = "billing.scan-auto-reload" as const

/**
 * Payloads carry ids and nothing else. The processor reads current state from
 * the database, so a job that sat in the queue through a deploy still acts on
 * what is true when it runs.
 */
export const refillPlanCreditsPayload = z.object({
	workspaceId: z.string().min(1),
	/** `YYYY-MM` the refill belongs to — also the ledger's idempotency key. */
	period: z.string().regex(/^\d{4}-\d{2}$/),
})

export type RefillPlanCreditsPayload = z.infer<typeof refillPlanCreditsPayload>

/**
 * The BullMQ job id doubles as a dedupe key: enqueueing the same workspace and
 * period twice replaces nothing and adds nothing. The ledger's unique
 * `(kind, reference)` index is the real backstop — this only saves the work.
 */
export async function enqueueRefillPlanCredits(workspaceId: string, at = new Date()) {
	const period = monthKey(at)
	await getQueue(QUEUE_BILLING).add(
		JOB_REFILL_PLAN_CREDITS,
		{ workspaceId, period } satisfies RefillPlanCreditsPayload,
		{ jobId: `refill:${workspaceId}:${period}` },
	)
}
