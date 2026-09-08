import { randomBytes } from "node:crypto"

import { NotFoundError } from "../../shared/errors"
import { decryptSecret, encryptSecret, maskSecret } from "../../shared/crypto"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import { enqueueWebhookDelivery } from "../../jobs/webhook.jobs"
import { auditService } from "../audit/audit.service"
import { safeFetch } from "../agent/tools/safe-fetch"
import { subscribes } from "./events"
import { signPayload } from "./signature"
import { webhookRepository } from "./webhook.repository"
import type { WebhookEndpointRow } from "./webhook.repository"
import type { SaveWebhookEndpointInput } from "./webhook.dto"

const log = logger.child({ module: "webhook" })

/** How much of the receiver's answer is kept as evidence. */
const MAX_RESPONSE_BODY = 2_000

/**
 * Consecutive failures before an endpoint is switched off.
 *
 * An endpoint whose host has been gone for a week is one we are paying to retry
 * into a void, and every retry is a queue slot a working endpoint could have
 * used. Switched off rather than deleted, so somebody can see why it stopped.
 */
const FAILURES_BEFORE_DISABLE = 20

function newSecret(): string {
	return `whsec_${randomBytes(24).toString("base64url")}`
}

export const webhookService = {
	async list(workspaceId: string) {
		return (await webhookRepository.list(workspaceId)).map(toPublic)
	},

	/**
	 * Creates an endpoint, returning its signing secret **once**.
	 *
	 * Once because it is encrypted at rest and never read back out to a caller —
	 * the API answers with the hint. Saying so at creation is what stops somebody
	 * closing the page and then asking where the secret went.
	 */
	async create(workspaceId: string, input: SaveWebhookEndpointInput, actorId: string) {
		const secret = newSecret()
		const id = newId()

		await webhookRepository.insert({
			id,
			organizationId: workspaceId,
			name: input.name,
			url: input.url,
			enabled: input.enabled,
			encryptedSecret: encryptSecret(secret),
			secretHint: maskSecret(secret),
			events: input.events,
			createdBy: actorId,
		})

		await auditService.record({
			action: "webhook.endpoint.created",
			actorId,
			organizationId: workspaceId,
			targetType: "webhook",
			targetId: id,
			metadata: { name: input.name, events: input.events },
		})

		const saved = await webhookRepository.findScoped(workspaceId, id)
		return { endpoint: saved ? toPublic(saved) : undefined, secret }
	},

	/**
	 * Changes an endpoint. The secret is untouched — rotating is its own call, so
	 * that saving a name change cannot invalidate a receiver's configuration.
	 */
	async update(
		workspaceId: string,
		endpointId: string,
		input: SaveWebhookEndpointInput,
		actorId: string,
	) {
		const existing = await webhookRepository.findScoped(workspaceId, endpointId)
		if (!existing) throw new NotFoundError("Webhook endpoint")

		await webhookRepository.update(endpointId, {
			name: input.name,
			url: input.url,
			enabled: input.enabled,
			events: input.events,
			// Re-enabling by hand is also the way to clear a disable: somebody has
			// looked at why it stopped, so the count starts again from there.
			...(input.enabled && !existing.enabled
				? { failureCount: 0, disabledAt: null, lastError: null }
				: {}),
		})

		await auditService.record({
			action: "webhook.endpoint.updated",
			actorId,
			organizationId: workspaceId,
			targetType: "webhook",
			targetId: endpointId,
			metadata: { name: input.name, events: input.events, enabled: input.enabled },
		})

		const saved = await webhookRepository.findScoped(workspaceId, endpointId)
		return saved ? toPublic(saved) : undefined
	},

	/** Issues a new secret and returns it once. The old one stops working here. */
	async rotateSecret(workspaceId: string, endpointId: string, actorId: string) {
		const existing = await webhookRepository.findScoped(workspaceId, endpointId)
		if (!existing) throw new NotFoundError("Webhook endpoint")

		const secret = newSecret()
		await webhookRepository.update(endpointId, {
			encryptedSecret: encryptSecret(secret),
			secretHint: maskSecret(secret),
		})

		await auditService.record({
			action: "webhook.endpoint.secret_rotated",
			actorId,
			organizationId: workspaceId,
			targetType: "webhook",
			targetId: endpointId,
		})

		return { secret }
	},

	async remove(workspaceId: string, endpointId: string, actorId: string) {
		const existing = await webhookRepository.findScoped(workspaceId, endpointId)
		if (!existing) throw new NotFoundError("Webhook endpoint")

		await webhookRepository.remove(endpointId)
		await auditService.record({
			action: "webhook.endpoint.deleted",
			actorId,
			organizationId: workspaceId,
			targetType: "webhook",
			targetId: endpointId,
			metadata: { name: existing.name },
		})
	},

	async listDeliveries(workspaceId: string, endpointId: string | undefined, limit = 100) {
		return webhookRepository.listDeliveries(workspaceId, endpointId, limit)
	},

	/**
	 * Fans one event out to whoever subscribed, and returns immediately.
	 *
	 * **Never throws.** This is called from the middle of things that succeeded —
	 * a run that produced an answer, a document that finished indexing — and a
	 * webhook that could not be enqueued must not turn one of those into a
	 * failure. The same reasoning as the provider error log: the failure to
	 * record is itself recorded and dropped.
	 */
	async emit(
		workspaceId: string,
		event: string,
		data: Record<string, unknown>,
	): Promise<void> {
		try {
			const endpoints = await webhookRepository.listEnabled(workspaceId)
			const subscribed = endpoints.filter((row) => subscribes(row.events, event))
			if (subscribed.length === 0) return

			const occurredAt = new Date().toISOString()

			for (const endpoint of subscribed) {
				const deliveryId = newId()
				// Serialised once, here, so every attempt signs and sends the same
				// bytes — see `jobs/webhook.jobs.ts`.
				const body = JSON.stringify({
					id: deliveryId,
					event,
					occurredAt,
					workspaceId,
					data,
				})

				await webhookRepository.insertDelivery({
					id: deliveryId,
					organizationId: workspaceId,
					endpointId: endpoint.id,
					event,
					payload: { id: deliveryId, event, occurredAt, workspaceId, data },
				})

				await enqueueWebhookDelivery({
					deliveryId,
					endpointId: endpoint.id,
					workspaceId,
					event,
					body,
				})
			}
		} catch (error) {
			log.warn("webhook.emit_failed", { event, workspaceId, error: String(error) })
		}
	},

	/**
	 * Posts one delivery.
	 *
	 * Through `safeFetch` rather than `fetch`, because the URL is one a customer
	 * typed: without the guard this is an SSRF primitive that reaches the
	 * deployment's own network from inside it, and a signed POST to
	 * 169.254.169.254 is no better for being signed.
	 *
	 * Throws on failure, which is what makes BullMQ retry it with the queue's
	 * exponential backoff. The row is written before the throw either way, so the
	 * failed attempts are readable rather than inferred.
	 */
	async deliver(input: {
		deliveryId: string
		endpointId: string
		workspaceId: string
		event: string
		body: string
		attempt: number
	}): Promise<void> {
		const endpoint = await webhookRepository.findById(input.endpointId)
		if (!endpoint) throw new NotFoundError("Webhook endpoint")

		// Disabled between the fan-out and this attempt: nothing to deliver, and
		// no reason to retry into it.
		if (!endpoint.enabled) {
			await webhookRepository.insertDelivery({
				id: newId(),
				organizationId: input.workspaceId,
				endpointId: input.endpointId,
				event: input.event,
				payload: { skipped: "endpoint disabled" },
				status: "failed",
				attempt: input.attempt,
				error: "The endpoint was switched off before this could be delivered.",
			})
			return
		}

		const secret = decryptSecret(endpoint.encryptedSecret)
		const timestamp = Math.floor(Date.now() / 1_000)
		const startedAt = Date.now()

		try {
			const response = await safeFetch(endpoint.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Ragenta-Event": input.event,
					"X-Ragenta-Delivery": input.deliveryId,
					"X-Ragenta-Signature": signPayload(secret, input.body, timestamp),
				},
				body: input.body,
			})

			const durationMs = Date.now() - startedAt
			// Any 2xx is taken. A receiver that answers 204 has accepted it as
			// surely as one that answers 200 with a body.
			const ok = response.status >= 200 && response.status < 300

			await webhookRepository.insertDelivery({
				id: newId(),
				organizationId: input.workspaceId,
				endpointId: input.endpointId,
				event: input.event,
				payload: { deliveryId: input.deliveryId, attempt: input.attempt },
				status: ok ? "succeeded" : "failed",
				attempt: input.attempt,
				responseStatus: response.status,
				responseBody: response.body.slice(0, MAX_RESPONSE_BODY),
				durationMs,
				deliveredAt: ok ? new Date() : null,
				error: ok ? null : `The endpoint answered ${response.status}.`,
			})

			if (ok) {
				await webhookRepository.update(input.endpointId, {
					failureCount: 0,
					lastDeliveryAt: new Date(),
					lastError: null,
				})
				return
			}

			await recordFailure(endpoint, `The endpoint answered ${response.status}.`)
			throw new Error(`Webhook delivery failed with ${response.status}`)
		} catch (error) {
			// A refusal from `safeFetch` — a private address, an unreachable host —
			// lands here rather than above, and is a failure like any other.
			if (error instanceof Error && error.message.startsWith("Webhook delivery failed")) {
				throw error
			}

			const message = error instanceof Error ? error.message : String(error)
			await webhookRepository.insertDelivery({
				id: newId(),
				organizationId: input.workspaceId,
				endpointId: input.endpointId,
				event: input.event,
				payload: { deliveryId: input.deliveryId, attempt: input.attempt },
				status: "failed",
				attempt: input.attempt,
				durationMs: Date.now() - startedAt,
				error: message.slice(0, 500),
			})

			await recordFailure(endpoint, message)
			throw error
		}
	},
}

/**
 * Counts a failure and switches the endpoint off once there have been enough.
 *
 * Best effort: this runs on the way to rethrowing, and a bookkeeping write that
 * failed must not replace the delivery error with its own.
 */
async function recordFailure(endpoint: WebhookEndpointRow, message: string): Promise<void> {
	try {
		const failureCount = endpoint.failureCount + 1
		const disabling = failureCount >= FAILURES_BEFORE_DISABLE

		await webhookRepository.update(endpoint.id, {
			failureCount,
			lastError: message.slice(0, 500),
			...(disabling ? { enabled: false, disabledAt: new Date() } : {}),
		})

		if (disabling) {
			log.warn("webhook.endpoint_disabled", {
				endpointId: endpoint.id,
				organizationId: endpoint.organizationId,
				failureCount,
			})
		}
	} catch (error) {
		log.warn("webhook.failure_bookkeeping_failed", {
			endpointId: endpoint.id,
			error: String(error),
		})
	}
}

/** The row as an API response: the hint, never the secret (ADR-021). */
function toPublic(row: WebhookEndpointRow) {
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		enabled: row.enabled,
		events: row.events,
		secretHint: row.secretHint,
		failureCount: row.failureCount,
		disabledAt: row.disabledAt,
		lastDeliveryAt: row.lastDeliveryAt,
		lastError: row.lastError,
		createdAt: row.createdAt,
	}
}
