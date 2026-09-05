import { Worker } from "bullmq"
import type { Job } from "bullmq"

import { JOB_SCAN_AUTO_RELOAD, JOB_SCAN_PLAN_REFILLS } from "../jobs/billing.jobs"
import { QUEUE_BILLING, QUEUE_INGESTION, getQueue } from "../queue/queues"
import { createRedisConnection } from "../redis/client"
import { logger } from "../shared/logger"
import { processBillingJob } from "./processors/billing.processor"
import { processIngestionJob } from "./processors/ingestion.processor"

const log = logger.child({ component: "worker" })

/** Concurrent jobs per worker process. Raise it per queue when work is IO-bound. */
const CONCURRENCY = 5

/**
 * Lower than the billing queue on purpose. An ingestion holds a whole document
 * in memory while it parses and embeds it, so concurrency here is a memory
 * ceiling as much as a throughput setting.
 */
const INGESTION_CONCURRENCY = 2

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

	const ingestionWorker = new Worker(
		QUEUE_INGESTION,
		async (job: Job) => processIngestionJob(job),
		{ connection: createRedisConnection(), concurrency: INGESTION_CONCURRENCY },
	)

	ingestionWorker.on("failed", (job, error) => {
		log.error("job.failed", error, {
			queue: QUEUE_INGESTION,
			jobId: job?.id,
			jobName: job?.name,
			attempt: job?.attemptsMade,
		})
	})

	ingestionWorker.on("completed", (job) => {
		log.info("job.completed", { queue: QUEUE_INGESTION, jobId: job.id, jobName: job.name })
	})

	return [billingWorker, ingestionWorker]
}

/**
 * Schedules the recurring work. Repeatable jobs are keyed by name, so
 * re-registering on every boot updates the schedule rather than stacking copies.
 */
export async function registerSchedules(): Promise<void> {
	const queue = getQueue(QUEUE_BILLING)

	await queue.add(
		JOB_SCAN_PLAN_REFILLS,
		{},
		{ repeat: { pattern: "0 * * * *" }, jobId: JOB_SCAN_PLAN_REFILLS },
	)

	// Every five minutes: a workspace that runs out mid-job should be topped up
	// before the next job, not an hour later.
	await queue.add(
		JOB_SCAN_AUTO_RELOAD,
		{},
		{ repeat: { pattern: "*/5 * * * *" }, jobId: JOB_SCAN_AUTO_RELOAD },
	)

	log.info("schedules.registered")
}
