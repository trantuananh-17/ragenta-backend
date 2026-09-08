import type { Job } from "bullmq"

import { JOB_DELIVER_WEBHOOK, deliverWebhookPayload } from "../../jobs/webhook.jobs"
import { webhookService } from "../../modules/webhook/webhook.service"

/**
 * Delivers one webhook, or throws so BullMQ retries it.
 *
 * The retries and their backoff are the queue's `DEFAULT_JOB_OPTIONS` rather
 * than a schedule of this module's own: five attempts with exponential backoff
 * is exactly the policy wanted here, and a second copy of it would be a second
 * thing to keep in step.
 *
 * `attemptsMade` is BullMQ's count of attempts *already finished*, so the
 * attempt being made now is one past it.
 */
export async function processWebhookJob(job: Job) {
	if (job.name !== JOB_DELIVER_WEBHOOK) {
		// An unknown name is a deploy mismatch, not a transient fault.
		throw new Error(`Unknown webhook job: ${job.name}`)
	}

	const payload = deliverWebhookPayload.parse(job.data)
	await webhookService.deliver({ ...payload, attempt: job.attemptsMade + 1 })
	return { deliveryId: payload.deliveryId }
}
