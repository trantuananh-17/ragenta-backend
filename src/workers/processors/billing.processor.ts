import type { Job } from "bullmq"

import { autoReloadService } from "../../modules/billing/autoreload.service"
import { billingService } from "../../modules/billing/billing.service"
import { logger } from "../../shared/logger"
import {
	JOB_REFILL_PLAN_CREDITS,
	JOB_SCAN_AUTO_RELOAD,
	JOB_SCAN_PLAN_REFILLS,
	enqueueRefillPlanCredits,
	refillPlanCreditsPayload,
} from "../../jobs/billing.jobs"

const log = logger.child({ processor: "billing" })

/** How many workspaces one scan tick fans out. Keeps a tick bounded. */
const SCAN_BATCH_SIZE = 500

/**
 * Finds workspaces whose plan period has elapsed and fans out one refill job
 * each. Runs on a schedule; skipping a tick or running two is harmless because
 * the refill itself is idempotent per period.
 */
async function scanPlanRefills() {
	const due = await billingService.listWorkspacesDueForRefill(new Date(), SCAN_BATCH_SIZE)
	for (const row of due) {
		await enqueueRefillPlanCredits(row.organizationId)
	}
	log.info("billing.scan.completed", { enqueued: due.length })
	return { enqueued: due.length }
}

async function refillPlanCredits(job: Job) {
	const payload = refillPlanCreditsPayload.parse(job.data)
	const result = await billingService.refillPlanCredits(payload.workspaceId)
	log.info("billing.refill.processed", {
		workspaceId: payload.workspaceId,
		period: payload.period,
		refilled: result.refilled,
	})
	return result
}

export async function processBillingJob(job: Job) {
	switch (job.name) {
		case JOB_SCAN_PLAN_REFILLS:
			return scanPlanRefills()
		case JOB_REFILL_PLAN_CREDITS:
			return refillPlanCredits(job)
		// Each candidate takes an atomic lock before it is charged, so a tick that
		// overlaps the previous one cannot double-bill a card.
		case JOB_SCAN_AUTO_RELOAD:
			return autoReloadService.runScan()
		default:
			// An unknown name is a deploy mismatch, not a transient fault. Fail it
			// outright rather than retrying five times against the same gap.
			throw new Error(`Unknown billing job: ${job.name}`)
	}
}
