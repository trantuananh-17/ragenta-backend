import { env } from "../../config/env"
import { logger } from "../../shared/logger"
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
}
