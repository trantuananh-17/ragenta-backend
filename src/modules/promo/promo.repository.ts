import { and, count, desc, eq, ilike, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { organization, promoCode, promoRedemption, user } from "../../db/schema"
import type { PaginationQuery } from "../../shared/pagination"

export type PromoCodeRow = typeof promoCode.$inferSelect
export type NewPromoCode = typeof promoCode.$inferInsert
export type PromoRedemptionRow = typeof promoRedemption.$inferSelect

const creator = alias(user, "creator")
const editor = alias(user, "editor")

export const promoRepository = {
	/**
	 * Newest first, with the two actor names resolved in the query. Two aliases
	 * of `user` rather than a second round trip — a list of 25 codes would
	 * otherwise cost 50 extra reads to render "created by".
	 */
	async list(search: string | undefined, query: PaginationQuery, executor: DbExecutor = db) {
		const where = search ? ilike(promoCode.code, `%${search.toUpperCase()}%`) : undefined

		const items = await executor
			.select({
				code: promoCode,
				createdByName: creator.name,
				createdByEmail: creator.email,
				updatedByName: editor.name,
				updatedByEmail: editor.email,
			})
			.from(promoCode)
			.leftJoin(creator, eq(creator.id, promoCode.createdBy))
			.leftJoin(editor, eq(editor.id, promoCode.updatedBy))
			.where(where)
			.orderBy(desc(promoCode.createdAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor.select({ value: count() }).from(promoCode).where(where)

		return { items, total: totals?.value ?? 0 }
	},

	async findByCode(code: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(promoCode)
			.where(eq(promoCode.code, code))
			.limit(1)
		return rows[0]
	},

	async findById(id: string, executor: DbExecutor = db) {
		const rows = await executor.select().from(promoCode).where(eq(promoCode.id, id)).limit(1)
		return rows[0]
	},

	/**
	 * Reads a code by its value and holds the row for the rest of the
	 * transaction. Redemption goes through this: `redeemed_count` against
	 * `max_redemptions` is a read-then-write, and two concurrent redemptions of
	 * the last slot would otherwise both see it free.
	 */
	async lockByCode(code: string, executor: DbExecutor) {
		const rows = await executor
			.select()
			.from(promoCode)
			.where(eq(promoCode.code, code))
			.limit(1)
			.for("update")
		return rows[0]
	},

	async lockById(id: string, executor: DbExecutor) {
		const rows = await executor
			.select()
			.from(promoCode)
			.where(eq(promoCode.id, id))
			.limit(1)
			.for("update")
		return rows[0]
	},

	async insert(entry: NewPromoCode, executor: DbExecutor = db) {
		const rows = await executor.insert(promoCode).values(entry).returning()
		return rows[0]
	},

	async update(
		id: string,
		patch: Partial<NewPromoCode>,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.update(promoCode)
			.set(patch)
			.where(eq(promoCode.id, id))
			.returning()
		return rows[0]
	},

	async remove(id: string, executor: DbExecutor = db) {
		const rows = await executor
			.delete(promoCode)
			.where(eq(promoCode.id, id))
			.returning({ id: promoCode.id })
		return rows.length > 0
	},

	async insertRedemption(
		entry: typeof promoRedemption.$inferInsert,
		executor: DbExecutor,
	) {
		const rows = await executor.insert(promoRedemption).values(entry).returning()
		return rows[0]
	},

	async incrementRedeemedCount(id: string, executor: DbExecutor) {
		await executor
			.update(promoCode)
			.set({ redeemedCount: sql`${promoCode.redeemedCount} + 1` })
			.where(eq(promoCode.id, id))
	},

	async findRedemption(
		codeId: string,
		workspaceId: string,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.select()
			.from(promoRedemption)
			.where(
				and(
					eq(promoRedemption.codeId, codeId),
					eq(promoRedemption.organizationId, workspaceId),
				),
			)
			.limit(1)
		return rows[0]
	},

	/** Redemptions of one code, with the workspace and person behind each. */
	async listRedemptions(codeId: string, query: PaginationQuery, executor: DbExecutor = db) {
		const items = await executor
			.select({
				id: promoRedemption.id,
				credits: promoRedemption.credits,
				createdAt: promoRedemption.createdAt,
				workspaceId: promoRedemption.organizationId,
				workspaceName: organization.name,
				userName: user.name,
				userEmail: user.email,
			})
			.from(promoRedemption)
			.leftJoin(organization, eq(organization.id, promoRedemption.organizationId))
			.leftJoin(user, eq(user.id, promoRedemption.userId))
			.where(eq(promoRedemption.codeId, codeId))
			.orderBy(desc(promoRedemption.createdAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor
			.select({ value: count() })
			.from(promoRedemption)
			.where(eq(promoRedemption.codeId, codeId))

		return { items, total: totals?.value ?? 0 }
	},

	/** Codes a workspace has already used, for its own billing screen. */
	async listRedemptionsForWorkspace(workspaceId: string, executor: DbExecutor = db) {
		return executor
			.select({
				id: promoRedemption.id,
				code: promoCode.code,
				credits: promoRedemption.credits,
				createdAt: promoRedemption.createdAt,
			})
			.from(promoRedemption)
			.innerJoin(promoCode, eq(promoCode.id, promoRedemption.codeId))
			.where(eq(promoRedemption.organizationId, workspaceId))
			.orderBy(desc(promoRedemption.createdAt))
	},
}
