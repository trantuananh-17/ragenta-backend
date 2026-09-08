import { z } from "zod"

/**
 * The date range a platform spend report is read over.
 *
 * In its own file, importing nothing, because its test must be able to run in a
 * check job that has no database: the service reaches the repository, which
 * reaches `db/client`, which validates the whole environment at import time. A
 * unit test that needs a `DATABASE_URL` is one this gate cannot run.
 */

export const platformUsageQuerySchema = z
	.object({
		/** Inclusive, `YYYY-MM-DD`. Defaults to 30 days before `to`. */
		from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
		/** Exclusive, `YYYY-MM-DD`. Defaults to tomorrow, so today is included. */
		to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
		/** How many workspaces the breakdown names. */
		limit: z.coerce.number().int().min(1).max(100).default(25),
	})
	.transform((value) => {
		const to = value.to ? startOfDay(value.to) : startOfTomorrow()
		const from = value.from ? startOfDay(value.from) : addDays(to, -30)
		return { from, to, limit: value.limit }
	})
	.refine(({ from, to }) => from < to, "The range must start before it ends.")

export type PlatformUsageQuery = z.infer<typeof platformUsageQuerySchema>

/**
 * Dates are read as UTC midnight rather than in the server's local zone. The VM
 * runs UTC, but a range that shifts with a machine's configuration makes two
 * deployments disagree about what "yesterday" contained.
 */
function startOfDay(date: string): Date {
	return new Date(`${date}T00:00:00.000Z`)
}

function addDays(date: Date, days: number): Date {
	return new Date(date.getTime() + days * 86_400_000)
}

function startOfTomorrow(): Date {
	const now = new Date()
	return addDays(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), 1)
}
