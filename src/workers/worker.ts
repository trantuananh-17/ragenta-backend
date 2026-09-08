import { Worker } from "bullmq"
import type { Job } from "bullmq"

import { JOB_SCAN_AUTO_RELOAD, JOB_SCAN_PLAN_REFILLS } from "../jobs/billing.jobs"
import { JOB_PRUNE_PROVIDER_ERRORS } from "../jobs/maintenance.jobs"
import { JOB_SCAN_TRIGGERS } from "../jobs/trigger.jobs"
import {
	QUEUE_AGENT,
	QUEUE_BILLING,
	QUEUE_INGESTION,
	QUEUE_WEBHOOK,
	getQueue,
} from "../queue/queues"
import { createRedisConnection } from "../redis/client"
import { logger } from "../shared/logger"
import { processAgentJob } from "./processors/agent.processor"
import { processBillingJob } from "./processors/billing.processor"
import { processIngestionJob } from "./processors/ingestion.processor"
import { processWebhookJob } from "./processors/webhook.processor"

const log = logger.child({ component: "worker" })

/** Concurrent jobs per worker process. Raise it per queue when work is IO-bound. */
const CONCURRENCY = 5

/**
 * Lower than the billing queue on purpose. An ingestion holds a whole document
 * in memory while it parses and embeds it, so concurrency here is a memory
 * ceiling as much as a throughput setting.
 */
const INGESTION_CONCURRENCY = 2

/**
 * Lower still. An agent run holds a provider stream open for as long as the
 * model keeps talking — minutes, over many rounds — so this is how many runs one
 * worker process is willing to be blocked on, not how much work it can get
 * through. Scale it by adding worker processes.
 */
const AGENT_CONCURRENCY = 2

/**
 * Higher than the rest, because a delivery is almost entirely waiting.
 *
 * It holds no memory and makes no provider call — it posts a small body and
 * waits up to ten seconds for somebody else's server. Ten at a time is a
 * throughput setting here rather than a resource ceiling, and it is what keeps a
 * burst behind one dead endpoint from starving every other workspace's.
 */
const WEBHOOK_CONCURRENCY = 10

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

	const agentWorker = new Worker(QUEUE_AGENT, async (job: Job) => processAgentJob(job), {
		connection: createRedisConnection(),
		concurrency: AGENT_CONCURRENCY,
	})

	agentWorker.on("failed", (job, error) => {
		log.error("job.failed", error, {
			queue: QUEUE_AGENT,
			jobId: job?.id,
			jobName: job?.name,
			attempt: job?.attemptsMade,
		})
	})

	agentWorker.on("completed", (job) => {
		log.info("job.completed", { queue: QUEUE_AGENT, jobId: job.id, jobName: job.name })
	})

	const webhookWorker = new Worker(QUEUE_WEBHOOK, async (job: Job) => processWebhookJob(job), {
		connection: createRedisConnection(),
		concurrency: WEBHOOK_CONCURRENCY,
	})

	// Logged at warn rather than error: a delivery failing is the ordinary case
	// this queue exists to retry, and logging it as an error would make a
	// customer's broken endpoint look like our outage.
	webhookWorker.on("failed", (job, error) => {
		log.warn("job.failed", {
			queue: QUEUE_WEBHOOK,
			jobId: job?.id,
			jobName: job?.name,
			attempt: job?.attemptsMade,
			error: String(error),
		})
	})

	webhookWorker.on("completed", (job) => {
		log.info("job.completed", { queue: QUEUE_WEBHOOK, jobId: job.id, jobName: job.name })
	})

	return [billingWorker, ingestionWorker, agentWorker, webhookWorker]
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

	// Nightly, at an hour nothing else is scheduled on. Missing a night costs
	// nothing: the next sweep deletes by age, not by what the last one left.
	await queue.add(
		JOB_PRUNE_PROVIDER_ERRORS,
		{},
		{ repeat: { pattern: "17 3 * * *" }, jobId: JOB_PRUNE_PROVIDER_ERRORS },
	)

	// Every minute, on the agent queue: a schedule cannot fire sooner than the
	// scan looks, which is why `schedule.ts` refuses a six-field expression.
	await getQueue(QUEUE_AGENT).add(
		JOB_SCAN_TRIGGERS,
		{},
		{ repeat: { pattern: "* * * * *" }, jobId: JOB_SCAN_TRIGGERS },
	)

	log.info("schedules.registered")
}
