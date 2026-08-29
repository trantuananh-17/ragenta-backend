import { Queue } from "bullmq"
import type { JobsOptions } from "bullmq"

import { createRedisConnection } from "../redis/client"

export const QUEUE_BILLING = "billing" as const

export type QueueName = typeof QUEUE_BILLING

/**
 * Defaults every job inherits. Explicit rather than relying on BullMQ's, because
 * "how many times does this retry" is a correctness property of the job, not an
 * implementation detail of the library version.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
	attempts: 5,
	backoff: { type: "exponential", delay: 5_000 },
	removeOnComplete: { count: 1_000, age: 7 * 24 * 3600 },
	removeOnFail: { age: 30 * 24 * 3600 },
}

const queues = new Map<QueueName, Queue>()

export function getQueue(name: QueueName): Queue {
	let queue = queues.get(name)
	if (!queue) {
		queue = new Queue(name, {
			connection: createRedisConnection(),
			defaultJobOptions: DEFAULT_JOB_OPTIONS,
		})
		queues.set(name, queue)
	}
	return queue
}

export async function closeQueues(): Promise<void> {
	await Promise.all([...queues.values()].map((queue) => queue.close()))
	queues.clear()
}
