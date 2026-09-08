import { z } from "zod"

import { platformUsageRepository } from "./platform-usage.repository"

/**
 * What the platform has spent, and on which model.
 *
 * **Tokens are what the provider counted; credits are what the customer was
 * charged.** They are different numbers with a margin between them, and a
 * dashboard that shows one labelled as the other is worse than one that shows
 * neither — so both travel, separately, all the way to the screen.
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

export const platformUsageService = {
	async overview({ from, to, limit }: PlatformUsageQuery) {
		const [totals, models, operations, workspaces, daily] = await Promise.all([
			platformUsageRepository.totals(from, to),
			platformUsageRepository.byModel(from, to),
			platformUsageRepository.byOperation(from, to),
			platformUsageRepository.byWorkspace(from, to, limit),
			platformUsageRepository.daily(from, to),
		])

		return {
			range: { from: from.toISOString(), to: to.toISOString() },
			totals,
			models,
			operations,
			workspaces,
			daily,
		}
	},

	async byModel(query: PlatformUsageQuery) {
		return {
			range: { from: query.from.toISOString(), to: query.to.toISOString() },
			models: await platformUsageRepository.byModel(query.from, query.to),
		}
	},

	async byWorkspace(query: PlatformUsageQuery) {
		return {
			range: { from: query.from.toISOString(), to: query.to.toISOString() },
			workspaces: await platformUsageRepository.byWorkspace(query.from, query.to, query.limit),
		}
	},
}
