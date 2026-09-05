import { relations, sql } from "drizzle-orm"
import {
	boolean,
	check,
	index,
	integer,
	numeric,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"

import { user } from "./auth.schema"
import { organization } from "./workspace.schema"

/**
 * Redeemable codes that grant credits to a workspace.
 *
 * Only the *code* expires here, never the credits it hands out. Ragenta's
 * balance has two buckets and neither carries a per-grant expiry — plan credits
 * are replaced wholesale at the next refill and top-up credits roll over
 * forever — so a promo cannot promise "credits valid 30 days" without a third
 * bucket the ledger does not have. `bucket` is the honest choice instead: which
 * of the two existing balances a redemption lands in, with the consequence
 * (replaced at refill, or kept) following from that.
 *
 * `redeemed_count` is a cache of `promo_redemption`, maintained in the same
 * transaction as the row that increments it. The redemption rows are the truth.
 */
export const promoCode = pgTable(
	"promo_code",
	{
		id: text("id").primaryKey(),
		/** Normalised to upper case before it is stored, so lookup is exact. */
		code: text("code").notNull().unique(),
		credits: numeric("credits", { precision: 14, scale: 4 }).notNull(),
		/** plan | topup — which balance a redemption adds to. */
		bucket: text("bucket").notNull(),
		/** When the code stops being redeemable. Always set: a code with no end is a liability. */
		expiresAt: timestamp("expires_at").notNull(),
		/** Null = unlimited. */
		maxRedemptions: integer("max_redemptions"),
		redeemedCount: integer("redeemed_count").default(0).notNull(),
		active: boolean("active").default(true).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
		updatedAt: timestamp("updated_at"),
		updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
	},
	(table) => [
		check("promoCode_bucket_check", sql`${table.bucket} in ('plan', 'topup')`),
		check("promoCode_credits_positive", sql`${table.credits} > 0`),
		check(
			"promoCode_maxRedemptions_positive",
			sql`${table.maxRedemptions} is null or ${table.maxRedemptions} > 0`,
		),
		index("promoCode_createdAt_idx").on(table.createdAt),
	],
)

/**
 * One row per workspace that redeemed a code. The unique index is the rule "a
 * workspace may redeem a given code once" — enforced by the database rather
 * than by a read-then-write in the service, which two concurrent redemptions
 * would both pass.
 */
export const promoRedemption = pgTable(
	"promo_redemption",
	{
		id: text("id").primaryKey(),
		codeId: text("code_id")
			.notNull()
			.references(() => promoCode.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** Who redeemed it. Null once that user is deleted; the redemption stands. */
		userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
		/** Credits granted at redemption time, frozen — the code may be edited later. */
		credits: numeric("credits", { precision: 14, scale: 4 }).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("promoRedemption_codeId_organizationId_uidx").on(
			table.codeId,
			table.organizationId,
		),
		index("promoRedemption_organizationId_idx").on(table.organizationId),
	],
)

export const promoCodeRelations = relations(promoCode, ({ many, one }) => ({
	redemptions: many(promoRedemption),
	creator: one(user, { fields: [promoCode.createdBy], references: [user.id] }),
}))

export const promoRedemptionRelations = relations(promoRedemption, ({ one }) => ({
	code: one(promoCode, { fields: [promoRedemption.codeId], references: [promoCode.id] }),
	organization: one(organization, {
		fields: [promoRedemption.organizationId],
		references: [organization.id],
	}),
	user: one(user, { fields: [promoRedemption.userId], references: [user.id] }),
}))
