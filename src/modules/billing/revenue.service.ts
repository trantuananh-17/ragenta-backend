import type { PlatformUsageQuery } from "../usage/platform-usage.dto"
import { isPlanName, monthlyPriceUsd, topupPackByCredits } from "./plans"
import type { PlanName } from "./plans"
import { paymentRepository } from "./payment.repository"
import { revenueRepository } from "./revenue.repository"

/**
 * What the deployment earns, what it costs, and the gap between them.
 *
 * Two numbers that look alike and are not, kept apart everywhere below:
 *
 *  - **Run rate** is what the active subscriptions bill in a month. It is a
 *    snapshot of today and ignores the report's date range entirely, because a
 *    plan price is not something that accrued over the last thirty days.
 *  - **Collected** is money that actually moved inside the range: top-up packs
 *    bought. Nothing else in this product records a payment — there is no
 *    invoice table, only Stripe — so a subscription charge is *not* in here.
 *
 * The margin therefore compares cost against **collected**, not against the run
 * rate. Mixing a monthly figure into a range total is the mistake this comment
 * exists to prevent: it would make a seven-day report look wildly profitable and
 * a ninety-day one look ruinous, from the same data.
 */

function toNumber(value: string | null | undefined): number {
	return value ? Number(value) : 0
}

export const revenueService = {
	async overview({ from, to, limit }: PlatformUsageQuery) {
		const [subscriptions, topups, banked, cost, costByWorkspace, daily] = await Promise.all([
			revenueRepository.activeSubscriptions(),
			revenueRepository.topupsWithin(from, to),
			paymentRepository.collectedWithin(from, to),
			revenueRepository.costWithin(from, to),
			revenueRepository.costByWorkspace(from, to, limit),
			revenueRepository.dailyCost(from, to),
		])

		const runRate = summariseRunRate(subscriptions)
		const ledger = summariseTopups(topups)
		const collected = summariseCollected(banked, ledger)
		const costUsd = toNumber(cost?.usd)

		return {
			range: { from: from.toISOString(), to: to.toISOString() },
			runRate,
			collected,
			cost: {
				usd: costUsd,
				credits: toNumber(cost?.credits),
				calls: cost?.calls ?? 0,
			},
			margin: {
				usd: collected.usd - costUsd,
				// Undefined rather than zero when nothing was collected: a ratio
				// against no revenue is not 0%, it is not a ratio.
				ratio: collected.usd > 0 ? (collected.usd - costUsd) / collected.usd : null,
			},
			costByWorkspace,
			daily,
		}
	},
}

interface SubscriptionRow {
	workspaceId: string
	name: string
	plan: string
	seats: number
}

function summariseRunRate(rows: SubscriptionRow[]) {
	const byPlan = new Map<string, { plan: string; workspaces: number; seats: number; usd: number }>()
	let mrrUsd = 0
	/** Workspaces on a plan with no list price — enterprise, invoiced by hand. */
	let unpricedWorkspaces = 0

	for (const row of rows) {
		const plan = isPlanName(row.plan) ? (row.plan as PlanName) : null
		const usd = plan ? monthlyPriceUsd(plan, row.seats) : null

		if (usd === null) unpricedWorkspaces += 1
		else mrrUsd += usd

		const bucket = byPlan.get(row.plan) ?? {
			plan: row.plan,
			workspaces: 0,
			seats: 0,
			usd: 0,
		}
		bucket.workspaces += 1
		bucket.seats += row.seats
		bucket.usd += usd ?? 0
		byPlan.set(row.plan, bucket)
	}

	return {
		mrrUsd,
		unpricedWorkspaces,
		workspaces: rows.length,
		byPlan: [...byPlan.values()].sort((a, b) => b.usd - a.usd),
	}
}

/**
 * What was actually collected, from the payment rows themselves.
 *
 * This used to be inferred: top-up credits were matched against the price of the
 * pack that grants that many, because no table recorded a payment. That guess is
 * gone now the `payment` table exists — a real amount beats an amount worked
 * backwards from what it bought, and it is the only way a *subscription* charge
 * could ever be counted at all.
 *
 * The credit figures from the ledger travel alongside rather than being dropped:
 * a range holding top-up credits but no payment row is a range from before
 * payments were recorded, and saying so is better than reporting the revenue as
 * zero without explanation.
 */
function summariseCollected(
	rows: { kind: string; usd: string; payments: number }[],
	ledger: { credits: number; purchases: number; unpricedCredits: number },
) {
	const byKind = (kind: string) => rows.find((row) => row.kind === kind)

	const subscriptionUsd = Number(byKind("subscription")?.usd ?? 0)
	const topupUsd = Number(byKind("topup")?.usd ?? 0)
	const payments = rows.reduce((total, row) => total + row.payments, 0)

	return {
		usd: subscriptionUsd + topupUsd,
		subscriptionUsd,
		topupUsd,
		payments,
		credits: ledger.credits,
		purchases: ledger.purchases,
		unpricedCredits: ledger.unpricedCredits,
	}
}

function summariseTopups(rows: { credits: string; purchases: number }[]) {
	let usd = 0
	let credits = 0
	let purchases = 0
	/**
	 * Credits granted under `topup` whose amount matches no pack we sell. An
	 * admin grant lands under its own kind, so this should stay empty — reported
	 * rather than dropped, because valuing it at zero would understate revenue
	 * silently and valuing it at a guess would overstate it.
	 */
	let unpricedCredits = 0

	for (const row of rows) {
		const amount = Number(row.credits)
		const pack = topupPackByCredits(amount)

		credits += amount * row.purchases
		purchases += row.purchases

		if (pack) usd += pack.priceUsd * row.purchases
		else unpricedCredits += amount * row.purchases
	}

	return { usd, credits, purchases, unpricedCredits }
}
