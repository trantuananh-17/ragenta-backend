import { and, count, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import {
	billingPreferences,
	creditBalance,
	creditTransaction,
	subscription,
} from "../../db/schema"
import type { PaginationQuery } from "../../shared/pagination"

export type CreditBalanceRow = typeof creditBalance.$inferSelect
export type CreditTransactionRow = typeof creditTransaction.$inferSelect
export type SubscriptionRow = typeof subscription.$inferSelect
export type NewCreditTransaction = typeof creditTransaction.$inferInsert

export const billingRepository = {
	async findBalance(workspaceId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(creditBalance)
			.where(eq(creditBalance.organizationId, workspaceId))
			.limit(1)
		return rows[0]
	},

	/**
	 * Reads the balance and holds a row lock for the rest of the transaction.
	 * Every spend and grant goes through this: two concurrent spends that both
	 * read the old balance would otherwise each write a total that ignores the
	 * other.
	 */
	async lockBalance(workspaceId: string, executor: DbExecutor) {
		const rows = await executor
			.select()
			.from(creditBalance)
			.where(eq(creditBalance.organizationId, workspaceId))
			.limit(1)
			.for("update")
		return rows[0]
	},

	async createBalanceIfMissing(workspaceId: string, executor: DbExecutor = db) {
		await executor
			.insert(creditBalance)
			.values({ organizationId: workspaceId })
			.onConflictDoNothing()
	},

	async setBalance(
		workspaceId: string,
		values: { planCredits?: string; topupCredits?: string; planResetAt?: Date },
		executor: DbExecutor,
	) {
		const rows = await executor
			.update(creditBalance)
			.set(values)
			.where(eq(creditBalance.organizationId, workspaceId))
			.returning()
		return rows[0]
	},

	/**
	 * Returns the inserted row, or undefined when `(kind, reference)` already
	 * exists — that unique index is what makes a retried job or a replayed
	 * webhook a no-op instead of a double posting.
	 */
	async insertTransaction(entry: NewCreditTransaction, executor: DbExecutor) {
		const rows = await executor
			.insert(creditTransaction)
			.values(entry)
			.onConflictDoNothing({
				target: [creditTransaction.kind, creditTransaction.reference],
			})
			.returning()
		return rows[0]
	},

	async listTransactions(
		workspaceId: string,
		query: PaginationQuery,
		executor: DbExecutor = db,
	) {
		const items = await executor
			.select()
			.from(creditTransaction)
			.where(eq(creditTransaction.organizationId, workspaceId))
			.orderBy(desc(creditTransaction.createdAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor
			.select({ value: count() })
			.from(creditTransaction)
			.where(eq(creditTransaction.organizationId, workspaceId))

		return { items, total: totals?.value ?? 0 }
	},

	async findSubscription(workspaceId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(subscription)
			.where(eq(subscription.organizationId, workspaceId))
			.limit(1)
		return rows[0]
	},

	async createSubscriptionIfMissing(
		entry: typeof subscription.$inferInsert,
		executor: DbExecutor = db,
	) {
		await executor.insert(subscription).values(entry).onConflictDoNothing({
			target: subscription.organizationId,
		})
	},

	async updateSubscription(
		workspaceId: string,
		patch: Partial<typeof subscription.$inferInsert>,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.update(subscription)
			.set(patch)
			.where(eq(subscription.organizationId, workspaceId))
			.returning()
		return rows[0]
	},

	async findByExternalSubscriptionId(externalId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(subscription)
			.where(eq(subscription.externalSubscriptionId, externalId))
			.limit(1)
		return rows[0]
	},

	// ── Auto-reload ────────────────────────────────────────────────────────────

	async findPreferences(workspaceId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(billingPreferences)
			.where(eq(billingPreferences.organizationId, workspaceId))
			.limit(1)
		return rows[0]
	},

	async upsertPreferences(
		workspaceId: string,
		values: Partial<typeof billingPreferences.$inferInsert>,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.insert(billingPreferences)
			.values({ organizationId: workspaceId, ...values })
			.onConflictDoUpdate({
				target: billingPreferences.organizationId,
				set: values,
			})
			.returning()
		return rows[0]
	},

	/**
	 * Workspaces whose balance has fallen under their auto-reload threshold and
	 * that are not already mid-charge.
	 *
	 * The whole predicate runs in SQL, including the balance comparison, so the
	 * worker never pulls a list it then has to filter — and the lock claim below
	 * repeats the expiry condition, so a row that became locked between this read
	 * and that write is still rejected.
	 */
	async listAutoReloadCandidates(executor: DbExecutor = db) {
		return executor
			.select({
				organizationId: billingPreferences.organizationId,
				pack: billingPreferences.autoReloadPack,
				customerId: subscription.externalCustomerId,
			})
			.from(billingPreferences)
			.innerJoin(
				creditBalance,
				eq(creditBalance.organizationId, billingPreferences.organizationId),
			)
			.innerJoin(
				subscription,
				eq(subscription.organizationId, billingPreferences.organizationId),
			)
			.where(
				and(
					eq(billingPreferences.autoReloadEnabled, true),
					sql`${billingPreferences.autoReloadThresholdCredits} is not null`,
					sql`${billingPreferences.autoReloadPack} is not null`,
					sql`${subscription.externalCustomerId} is not null`,
					sql`(${creditBalance.planCredits} + ${creditBalance.topupCredits}) < ${billingPreferences.autoReloadThresholdCredits}`,
					or(
						isNull(billingPreferences.autoReloadLockedUntil),
						lt(billingPreferences.autoReloadLockedUntil, sql`now()`),
					),
				),
			)
	},

	/**
	 * Take the single-flight lock, atomically.
	 *
	 * A conditional UPDATE, not read-then-write: two workers reading "unlocked"
	 * at the same time and both proceeding is exactly the race this guards, and
	 * only one UPDATE can match the unlocked predicate. An empty result means
	 * somebody else owns the charge.
	 */
	async claimAutoReloadLock(workspaceId: string, minutes: number, executor: DbExecutor = db) {
		const rows = await executor
			.update(billingPreferences)
			.set({ autoReloadLockedUntil: sql`now() + (${minutes} * interval '1 minute')` })
			.where(
				and(
					eq(billingPreferences.organizationId, workspaceId),
					or(
						isNull(billingPreferences.autoReloadLockedUntil),
						lt(billingPreferences.autoReloadLockedUntil, sql`now()`),
					),
				),
			)
			.returning({ organizationId: billingPreferences.organizationId })
		return rows.length > 0
	},

	/**
	 * Release the lock. With a failure code it also disables auto-reload:
	 * retrying a declined card every five minutes is how an account gets flagged
	 * by the issuer, and the customer needs to fix the card anyway.
	 */
	async releaseAutoReloadLock(
		workspaceId: string,
		failureCode?: string,
		executor: DbExecutor = db,
	) {
		await executor
			.update(billingPreferences)
			.set({
				autoReloadLockedUntil: null,
				...(failureCode
					? {
							autoReloadEnabled: false,
							lastFailureCode: failureCode,
							lastFailureAt: new Date(),
						}
					: { lastFailureCode: null, lastFailureAt: null }),
			})
			.where(eq(billingPreferences.organizationId, workspaceId))
	},

	/** Workspaces whose plan period has elapsed — the refill worker's work list. */
	async listWorkspacesDueForRefill(before: Date, limit: number, executor: DbExecutor = db) {
		return executor
			.select({
				organizationId: creditBalance.organizationId,
				planResetAt: creditBalance.planResetAt,
			})
			.from(creditBalance)
			.where(lte(creditBalance.planResetAt, before))
			.orderBy(creditBalance.planResetAt)
			.limit(limit)
	},
}
