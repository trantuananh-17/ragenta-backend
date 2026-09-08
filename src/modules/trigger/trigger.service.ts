import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

import { NotFoundError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import { auditService } from "../audit/audit.service"
import { agentRepository } from "../agent/agent.repository"
import { agentService } from "../agent/agent.service"
import { backoffMinutes, nextRun, validateCron } from "./schedule"
import { triggerRepository } from "./trigger.repository"
import type { TriggerRow } from "./trigger.repository"
import type { SaveTriggerInput } from "./trigger.dto"

const log = logger.child({ module: "trigger" })

/** How many due schedules one scan claims. Bounded so one minute's work is bounded. */
const SCAN_BATCH = 50

/**
 * A webhook's secret is **hashed**, not encrypted.
 *
 * It is a credential the caller presents rather than one we present to somebody
 * else, so it is verified and never replayed — the same reason an API key is
 * stored hashed (`.claude/rules/security.md`). SHA-256 without a work factor is
 * right here and would be wrong for a password: this secret is 32 random bytes
 * that we generated, so there is no dictionary to run against it and the cost of
 * a slow hash would be paid on every inbound request instead.
 */
function hashSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("hex")
}

function secretMatches(presented: string, storedHash: string): boolean {
	const a = Buffer.from(hashSecret(presented), "hex")
	const b = Buffer.from(storedHash, "hex")
	// Constant time, so the number of matching leading bytes is not observable.
	return a.length === b.length && timingSafeEqual(a, b)
}

export const triggerService = {
	async list(workspaceId: string, agentId: string) {
		const agent = await agentRepository.findById(workspaceId, agentId)
		if (!agent) throw new NotFoundError("Agent")
		return (await triggerRepository.listForAgent(workspaceId, agentId)).map(toPublic)
	},

	/**
	 * Creates a trigger, returning the webhook secret **once**.
	 *
	 * Once, because it is stored hashed and there is nothing to show afterwards.
	 * Saying so at creation is what stops somebody closing the dialog and then
	 * asking where the secret went.
	 */
	async create(
		workspaceId: string,
		agentId: string,
		input: SaveTriggerInput,
		actorId: string,
	) {
		const agent = await agentRepository.findById(workspaceId, agentId)
		if (!agent) throw new NotFoundError("Agent")

		const id = newId()
		let secret: string | undefined

		const row: Parameters<typeof triggerRepository.insert>[0] = {
			id,
			organizationId: workspaceId,
			agentId,
			kind: input.kind,
			name: input.name,
			enabled: input.enabled,
			input: input.input,
			timezone: input.timezone,
			createdBy: actorId,
		}

		if (input.kind === "schedule") {
			if (!input.cron) throw new ValidationError("A schedule needs a cron expression.")
			const problem = validateCron(input.cron, input.timezone)
			if (problem) throw new ValidationError(problem.message)

			row.cron = input.cron
			// Computed at creation rather than at the first scan: a schedule whose
			// next run is unknown is one the scan's indexed query cannot find.
			row.nextRunAt = nextRun(input.cron, input.timezone) ?? null
		} else {
			secret = randomBytes(32).toString("base64url")
			row.secretHash = hashSecret(secret)
			row.secretHint = `${secret.slice(0, 6)}…`
		}

		await triggerRepository.insert(row)

		await auditService.record({
			action: "agent.trigger.created",
			actorId,
			organizationId: workspaceId,
			targetType: "agent",
			targetId: agentId,
			metadata: { triggerId: id, kind: input.kind, name: input.name },
		})

		const saved = await triggerRepository.findScoped(workspaceId, id)
		return { trigger: saved ? toPublic(saved) : undefined, secret }
	},

	async update(
		workspaceId: string,
		triggerId: string,
		input: SaveTriggerInput,
		actorId: string,
	) {
		const existing = await triggerRepository.findScoped(workspaceId, triggerId)
		if (!existing) throw new NotFoundError("Trigger")
		if (existing.kind !== input.kind) {
			// The two kinds are configured by different fields and one holds a
			// credential. Turning one into the other in place would leave a webhook's
			// secret attached to a schedule, or a schedule with no way to fire.
			throw new ValidationError("A trigger's kind cannot be changed. Create a new one.")
		}

		const fields: Parameters<typeof triggerRepository.update>[1] = {
			name: input.name,
			enabled: input.enabled,
			input: input.input,
			timezone: input.timezone,
		}

		if (input.kind === "schedule") {
			if (!input.cron) throw new ValidationError("A schedule needs a cron expression.")
			const problem = validateCron(input.cron, input.timezone)
			if (problem) throw new ValidationError(problem.message)

			fields.cron = input.cron
			// Recomputed from now, so an edited schedule takes effect immediately
			// rather than after whatever the old expression had queued.
			fields.nextRunAt = input.enabled ? (nextRun(input.cron, input.timezone) ?? null) : null
			fields.failureCount = 0
			fields.lastError = null
		}

		await triggerRepository.update(triggerId, fields)

		await auditService.record({
			action: "agent.trigger.updated",
			actorId,
			organizationId: workspaceId,
			targetType: "agent",
			targetId: existing.agentId,
			metadata: { triggerId, enabled: input.enabled },
		})

		const saved = await triggerRepository.findScoped(workspaceId, triggerId)
		return saved ? toPublic(saved) : undefined
	},

	async remove(workspaceId: string, triggerId: string, actorId: string) {
		const existing = await triggerRepository.findScoped(workspaceId, triggerId)
		if (!existing) throw new NotFoundError("Trigger")

		await triggerRepository.remove(triggerId)
		await auditService.record({
			action: "agent.trigger.deleted",
			actorId,
			organizationId: workspaceId,
			targetType: "agent",
			targetId: existing.agentId,
			metadata: { triggerId, kind: existing.kind },
		})
	},

	/**
	 * A webhook fired by a stranger.
	 *
	 * The only endpoint here with no session behind it, so what stands in for the
	 * tenant filter is the secret: a caller has to prove they hold it before
	 * anything is read out of the row. Everything after that is deliberate:
	 *
	 *  - **404 for a missing, disabled or wrong-secret trigger, always the same
	 *    answer.** Distinguishing them would turn this into an oracle for which
	 *    ids exist.
	 *  - The payload becomes the agent's input, **capped**, and the trigger's own
	 *    `input` is the fallback when the body carries nothing usable.
	 *  - The run is queued, never executed inline. A webhook caller wants a 202,
	 *    not to hold a connection open through a model loop.
	 */
	async fireWebhook(
		triggerId: string,
		presentedSecret: string,
		payload: string,
	): Promise<{ runId: string }> {
		const trigger = await triggerRepository.findById(triggerId)

		if (
			!trigger ||
			trigger.kind !== "webhook" ||
			!trigger.enabled ||
			!trigger.secretHash ||
			!secretMatches(presentedSecret, trigger.secretHash)
		) {
			throw new NotFoundError("Webhook")
		}

		const input = payload.trim().slice(0, 8_000) || trigger.input
		if (!input) {
			throw new ValidationError(
				"This webhook carried no body and its trigger has no default input.",
			)
		}

		const queued = await agentService.queueRun(
			trigger.organizationId,
			trigger.agentId,
			{ input },
			// No person is behind this run, and recording one would put somebody's
			// name on a run they were asleep for.
			null,
			"webhook",
		)

		await triggerRepository.update(trigger.id, { lastFiredAt: new Date() })
		log.info("trigger.webhook_fired", { triggerId, runId: queued.runId })

		return { runId: queued.runId }
	},

	/**
	 * One pass over the schedules that are due.
	 *
	 * Each is **claimed** before it is run — the update carries the `next_run_at`
	 * it was read with, so two workers scanning the same second both see the row
	 * and only one changes it. Without that a schedule fires once per worker,
	 * which is a duplicate run and a duplicate bill.
	 */
	async fireDueSchedules(now: Date = new Date()): Promise<number> {
		const due = await triggerRepository.listDue(now, SCAN_BATCH)
		let fired = 0

		for (const trigger of due) {
			if (!trigger.nextRunAt || !trigger.cron) continue

			const following = nextRun(trigger.cron, trigger.timezone, now) ?? null
			const claimed = await triggerRepository.claim(trigger.id, trigger.nextRunAt, following)
			if (!claimed) continue

			try {
				const queued = await agentService.queueRun(
					trigger.organizationId,
					trigger.agentId,
					{ input: trigger.input },
					null,
					"schedule",
				)
				await triggerRepository.update(trigger.id, { failureCount: 0, lastError: null })
				fired += 1
				log.info("trigger.schedule_fired", { triggerId: trigger.id, runId: queued.runId })
			} catch (error) {
				// A trigger whose agent refuses every run would otherwise fire every
				// minute forever, writing a failed run each time. Back it off, and
				// keep the reason where somebody can read it.
				const failures = trigger.failureCount + 1
				const message = error instanceof Error ? error.message : String(error)

				await triggerRepository.update(trigger.id, {
					failureCount: failures,
					lastError: message.slice(0, 500),
					nextRunAt: new Date(now.getTime() + backoffMinutes(failures) * 60_000),
				})
				log.warn("trigger.schedule_failed", { triggerId: trigger.id, failures, error: message })
			}
		}

		return fired
	},
}

/** The row as an API response. Never the secret — only the hint, and only once at creation. */
function toPublic(row: TriggerRow) {
	return {
		id: row.id,
		agentId: row.agentId,
		kind: row.kind,
		name: row.name,
		enabled: row.enabled,
		input: row.input,
		cron: row.cron,
		timezone: row.timezone,
		secretHint: row.secretHint,
		nextRunAt: row.nextRunAt,
		lastFiredAt: row.lastFiredAt,
		failureCount: row.failureCount,
		lastError: row.lastError,
		createdAt: row.createdAt,
	}
}
