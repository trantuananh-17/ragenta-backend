import { count, desc, eq, lte } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { creditBalance, creditTransaction, subscription } from "../../db/schema"
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
