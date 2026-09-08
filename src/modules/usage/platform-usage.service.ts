import type { PlatformUsageQuery } from "./platform-usage.dto"
import { platformUsageRepository } from "./platform-usage.repository"

/**
 * What the platform has spent, and on which model.
 *
 * **Tokens are what the provider counted; credits are what the customer was
 * charged.** They are different numbers with a margin between them, and a
 * dashboard that shows one labelled as the other is worse than one that shows
 * neither — so both travel, separately, all the way to the screen.
 */

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
