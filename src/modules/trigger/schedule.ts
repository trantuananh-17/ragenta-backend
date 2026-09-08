import { CronExpressionParser } from "cron-parser"

/**
 * When a cron expression next comes due, in UTC.
 *
 * In its own module, importing only the parser, so it can be tested in a check
 * job with no database — and because it is the part of a scheduler that is worth
 * being sure about. A schedule that fires at the wrong hour is a class of bug
 * nobody notices for a week.
 *
 * **The timezone is not cosmetic.** "Every weekday at 09:00" is a different
 * instant in Hanoi than in London, and a schedule silently evaluated in UTC is
 * wrong for everybody outside it — by seven hours here, and by a whole day for
 * anything near midnight. The zone is stored on the trigger and passed through;
 * `cron-parser` is what makes it correct across a daylight-saving change, which
 * is precisely the arithmetic not worth hand-rolling (ADR-058).
 */

export interface ScheduleProblem {
	message: string
}

/** Five fields. Seconds are deliberately not offered — see `nextRun`. */
export function validateCron(expression: string, timezone: string): ScheduleProblem | undefined {
	const trimmed = expression.trim()

	if (trimmed.split(/\s+/).length !== 5) {
		return {
			message: "Use a five-field cron expression: minute, hour, day, month, weekday.",
		}
	}

	try {
		// `next()`, not just `parse()`. Parsing accepts a timezone it cannot resolve
		// and only fails when asked for an actual instant — so a validation that
		// stopped at parsing would accept rows the scheduler could never fire, and
		// the first sign of it would be a schedule that silently never runs.
		CronExpressionParser.parse(trimmed, { tz: timezone }).next()
		return undefined
	} catch (error) {
		return { message: error instanceof Error ? error.message : "That expression is not valid." }
	}
}

/**
 * The next instant this expression is due after `from`, or `undefined` when the
 * expression cannot be read.
 *
 * The scan runs every minute, so a schedule finer than a minute would fire late
 * and unpredictably rather than often — which is why five fields are accepted
 * and six are refused. Somebody wanting a job every ten seconds wants a queue,
 * not a schedule.
 */
export function nextRun(
	expression: string,
	timezone: string,
	from: Date = new Date(),
): Date | undefined {
	try {
		const parsed = CronExpressionParser.parse(expression.trim(), {
			tz: timezone,
			currentDate: from,
		})
		return parsed.next().toDate()
	} catch {
		return undefined
	}
}

/**
 * How long to wait before trying a trigger that keeps failing.
 *
 * Exponential, capped at an hour. A trigger whose agent refuses every run — no
 * credits, a deleted knowledge base — would otherwise fire every minute forever,
 * writing a failed run each time and charging for whatever got as far as the
 * model before it failed.
 */
export function backoffMinutes(consecutiveFailures: number): number {
	if (consecutiveFailures <= 0) return 0
	return Math.min(60, 2 ** Math.min(consecutiveFailures - 1, 6))
}
