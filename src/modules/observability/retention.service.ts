import { env } from "../../config/env"
import { logger } from "../../shared/logger"
import { webhookRepository } from "../webhook/webhook.repository"
import { errorLogService } from "./error-log.service"

const log = logger.child({ module: "observability" })

/**
 * How many rows one sweep deletes.
 *
 * The first sweep after this ships has however much history the deployment
 * accumulated behind it, and one unbounded delete would hold a lock over the
 * table the admin console reads. Bounded, the sweep simply takes several nights
 * to catch up — which costs nothing, because nobody is waiting on it.
 */
const SWEEP_BATCH = 5_000

export const retentionService = {
	/**
	 * Drops provider failures past the retention window.
	 *
	 * Retention is configuration, not a constant: staging's month-old failures are
	 * noise, production's are the answer to "what happened last month". Zero
	 * disables the sweep entirely — the escape hatch for an incident nobody wants
	 * trimmed out from under them while it is being investigated.
	 */
	async pruneProviderErrors() {
		const days = env.observability.providerErrorRetentionDays
		const deleted = await errorLogService.pruneOlderThan(days, SWEEP_BATCH)

		log.info("observability.retention.swept", {
			days,
			deleted,
			// True means there is more to do and tomorrow's sweep will do it. Said
			// out loud so a table that never shrinks is visible in the logs rather
			// than inferred from its size.
			more: deleted === SWEEP_BATCH,
		})

		return { days, deleted }
	},

	/**
	 * Drops delivery rows past the same window.
	 *
	 * The delivery log grows with traffic rather than with what is wrong, so it
	 * needs this more than the error log does — but it is the same decision, so it
	 * reads the same setting rather than gaining one nobody would think to change
	 * independently.
	 */
	async pruneWebhookDeliveries() {
		const days = env.observability.providerErrorRetentionDays
		if (days <= 0) return { days, deleted: 0 }

		const cutoff = new Date(Date.now() - days * 86_400_000)
		const deleted = await webhookRepository.pruneDeliveriesOlderThan(cutoff, SWEEP_BATCH)

		log.info("webhook.retention.swept", { days, deleted, more: deleted === SWEEP_BATCH })
		return { days, deleted }
	},
}
