import { z } from "zod"

import { QUEUE_WEBHOOK, getQueue } from "../queue/queues"

export const JOB_DELIVER_WEBHOOK = "webhook.deliver" as const

/**
 * The payload carries the **body**, not just ids.
 *
 * The exception to this codebase's rule that a job reads current state when it
 * runs, and it is the point of the feature rather than a shortcut: what was
 * signed has to be what is sent, on every attempt. A retry that rebuilt the
 * payload from the database would deliver a *different* body for the same event
 * — a run's credits, say, updated between attempts — and a receiver dedupeing on
 * the delivery id would then hold two contradictory versions of one event.
 */
export const deliverWebhookPayload = z.object({
	deliveryId: z.string().min(1),
	endpointId: z.string().min(1),
	workspaceId: z.string().min(1),
	event: z.string().min(1),
	/** Serialised once, at fan-out. The exact bytes that get signed. */
	body: z.string().min(1),
})

export type DeliverWebhookPayload = z.infer<typeof deliverWebhookPayload>

export async function enqueueWebhookDelivery(payload: DeliverWebhookPayload) {
	await getQueue(QUEUE_WEBHOOK).add(JOB_DELIVER_WEBHOOK, payload, {
		// The delivery id is the dedupe key: a fan-out retried after a crash
		// enqueues the same id and adds nothing.
		jobId: `webhook:${payload.deliveryId}`,
	})
}
