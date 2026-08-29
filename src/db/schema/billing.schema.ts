import { relations } from "drizzle-orm"
import {
	boolean,
	index,
	integer,
	numeric,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"

import { organization } from "./workspace.schema"

/**
 * Billing is workspace-scoped and ledger-first (ADR: token accounting).
 *
 * `credit_balance` is a materialised sum, not the truth — every change to it is
 * written alongside a `credit_transaction` row in the same transaction, so the
 * balance can always be recomputed from the ledger. Nothing may UPDATE a
 * balance without appending the matching ledger row.
 */
export const subscription = pgTable(
	"subscription",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** free | pro | enterprise — see src/modules/billing/plans.ts */
		plan: text("plan").notNull(),
		/** incomplete | active | past_due | canceled */
		status: text("status").default("incomplete").notNull(),
		seats: integer("seats"),
		/** monthly | yearly */
		billingInterval: text("billing_interval"),
		periodStart: timestamp("period_start"),
		periodEnd: timestamp("period_end"),
		cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
		canceledAt: timestamp("canceled_at"),
		/**
		 * Ids at the payment provider. Left provider-neutral on purpose: no
		 * payment integration exists yet, and naming these `stripe*` would bake a
		 * vendor into the schema before that decision is made.
		 */
		externalCustomerId: text("external_customer_id"),
		externalSubscriptionId: text("external_subscription_id"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index("subscription_organizationId_idx").on(table.organizationId),
		// One live subscription row per workspace at a time.
		uniqueIndex("subscription_organizationId_uidx").on(table.organizationId),
	],
)

export const creditBalance = pgTable("credit_balance", {
	organizationId: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	/** Refilled from the plan every period; the remainder does not roll over. */
	planCredits: numeric("plan_credits", { precision: 14, scale: 4 }).default("0").notNull(),
	/** Purchased separately; rolls over. Spent only after plan credits run out. */
	topupCredits: numeric("topup_credits", { precision: 14, scale: 4 }).default("0").notNull(),
	planResetAt: timestamp("plan_reset_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
})

export const creditTransaction = pgTable(
	"credit_transaction",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** plan_refill | signup_grant | topup | deduct | refund | admin_adjust */
		kind: text("kind").notNull(),
		/** plan | topup — which bucket the amount moved in or out of. */
		bucket: text("bucket").notNull(),
		/** Positive adds credit, negative spends it. */
		amount: numeric("amount", { precision: 14, scale: 4 }).notNull(),
		/**
		 * Idempotency key, unique per kind. Required (never null) because Postgres
		 * treats NULLs as distinct, which would make the unique index below stop
		 * enforcing anything: a retried refill or a replayed webhook would post
		 * twice.
		 */
		reference: text("reference").notNull(),
		/** What consumed the credit: chat | embedding | ingestion | agent | admin. */
		source: text("source"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("creditTransaction_organizationId_createdAt_idx").on(
			table.organizationId,
			table.createdAt,
		),
		uniqueIndex("creditTransaction_kind_reference_uidx").on(table.kind, table.reference),
	],
)

export const subscriptionRelations = relations(subscription, ({ one }) => ({
	organization: one(organization, {
		fields: [subscription.organizationId],
		references: [organization.id],
	}),
}))

export const creditBalanceRelations = relations(creditBalance, ({ one }) => ({
	organization: one(organization, {
		fields: [creditBalance.organizationId],
		references: [organization.id],
	}),
}))

export const creditTransactionRelations = relations(creditTransaction, ({ one }) => ({
	organization: one(organization, {
		fields: [creditTransaction.organizationId],
		references: [organization.id],
	}),
}))
