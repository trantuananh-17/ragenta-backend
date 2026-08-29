import { Worker } from "bullmq"
import type { Job } from "bullmq"

import { JOB_SCAN_PLAN_REFILLS } from "../jobs/billing.jobs"
import { QUEUE_BILLING, getQueue } from "../queue/queues"
import { createRedisConnection } from "../redis/client"
import { logger } from "../shared/logger"
import { processBillingJob } from "./processors/billing.processor"

const log = logger.child({ component: "worker" })

/** Concurrent jobs per worker process. Raise it per queue when work is IO-bound. */
const CONCURRENCY = 5

export function startWorkers(): Worker[] {
	const billingWorker = new Worker(
		QUEUE_BILLING,
		async (job: Job) => processBillingJob(job),
		{ connection: createRedisConnection(), concurrency: CONCURRENCY },
	)

	billingWorker.on("failed", (job, error) => {
		log.error("job.failed", error, {
			queue: QUEUE_BILLING,
			jobId: job?.id,
			jobName: job?.name,
			attempt: job?.attemptsMade,
		})
	})

	billingWorker.on("completed", (job) => {
		log.info("job.completed", { queue: QUEUE_BILLING, jobId: job.id, jobName: job.name })
	})

	return [billingWorker]
}

/**
 * Schedules the recurring work. Repeatable jobs are keyed by name, so
 * re-registering on every boot updates the schedule rather than stacking copies.
 */
export async function registerSchedules(): Promise<void> {
	await getQueue(QUEUE_BILLING).add(
		JOB_SCAN_PLAN_REFILLS,
		{},
		{
			repeat: { pattern: "0 * * * *" },
			jobId: JOB_SCAN_PLAN_REFILLS,
		},
	)
	log.info("schedules.registered")
}
