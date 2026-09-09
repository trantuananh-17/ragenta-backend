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

import { organization } from "./workspace.schema"

/**
 * Auto-reload: buy a top-up pack automatically when the balance runs low, so a
 * long job does not die mid-run because the workspace ran out of credits.
 *
 * `autoReloadLockedUntil` is a single-flight guard, and it is the only reason
 * this table is not just three columns on `subscription`. The scan job claims it
 * with a conditional UPDATE before creating a PaymentIntent; the webhook clears
 * it on success. Without it, two scan ticks overlapping — or two worker replicas
 * — each see a low balance and each charge the card.
 */
export const billingPreferences = pgTable("billing_preferences", {
	organizationId: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	autoReloadEnabled: boolean("auto_reload_enabled").default(false).notNull(),
	/** Fire when plan + top-up credits fall below this. */
	autoReloadThresholdCredits: integer("auto_reload_threshold_credits"),
	/** Which top-up pack to buy. A pack, not an amount, so the price is never derived. */
	autoReloadPack: text("auto_reload_pack"),
	autoReloadLockedUntil: timestamp("auto_reload_locked_until"),
	/**
	 * Why the last attempt failed, kept so the UI can explain itself. A failed
	 * charge also turns `autoReloadEnabled` off — retrying a declined card every
	 * five minutes is how an account gets flagged by the issuer.
	 */
	lastFailureCode: text("last_failure_code"),
	lastFailureAt: timestamp("last_failure_at"),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
})

export const billingPreferencesRelations = relations(billingPreferences, ({ one }) => ({
	organization: one(organization, {
		fields: [billingPreferences.organizationId],
		references: [organization.id],
	}),
}))

/**
 * Money that actually changed hands.
 *
 * Nothing in this product recorded a payment before: a subscription charge and a
 * top-up purchase both landed as *credits* — `credit_transaction` — and the
 * dollars behind them existed only inside Stripe. That made three questions
 * unanswerable without opening someone else's dashboard: what has this workspace
 * paid us, which invoice covers which period, and what did we actually collect
 * last month.
 *
 * `amount_usd` is frozen for the same reason `usage_ledger.cost_usd` is (ADR-013):
 * it is what was charged, and no later price change may restate it.
 *
 * The provider's id is `external_id` and is **unique**, which is what makes a
 * webhook redelivery a no-op — the same rule `credit_transaction` gets from its
 * `(kind, reference)` index. One invoice is one row: a charge that fails and
 * then succeeds updates its status rather than writing a second row, because it
 * is one attempt to collect one amount and a customer reading two lines for it
 * would reasonably think they were billed twice.
 */
export const payment = pgTable(
	"payment",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** subscription | topup */
		kind: text("kind").notNull(),
		/** paid | failed | refunded */
		status: text("status").notNull(),
		amountUsd: numeric("amount_usd", { precision: 12, scale: 2 }).notNull(),
		currency: text("currency").default("usd").notNull(),
		/** What the customer sees on the row: "Pro — 3 seats", "Top-up 5M". */
		description: text("description").notNull(),
		/**
		 * The payment provider's own id — an invoice, a checkout session or a
		 * payment intent, depending on what was bought. Provider-neutral in name
		 * for the reason `subscription.external_customer_id` is: naming it `stripe`
		 * would bake a vendor into the schema.
		 */
		externalId: text("external_id").notNull(),
		/** Stripe's hosted invoice page, so a customer can fetch their own receipt. */
		hostedInvoiceUrl: text("hosted_invoice_url"),
		invoicePdfUrl: text("invoice_pdf_url"),
		/** The period a subscription charge covers. Null for a one-off top-up. */
		periodStart: timestamp("period_start"),
		periodEnd: timestamp("period_end"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		check("payment_kind_check", sql`${table.kind} in ('subscription', 'topup')`),
		check("payment_status_check", sql`${table.status} in ('paid', 'failed', 'refunded')`),
		uniqueIndex("payment_externalId_uidx").on(table.externalId),
		index("payment_organizationId_createdAt_idx").on(table.organizationId, table.createdAt),
		// The platform-wide report filters on a date range across every tenant, so
		// it needs an index that does not start with the workspace — the same shape
		// `usage_ledger` needed for the same screen (ADR-051).
		index("payment_createdAt_idx").on(table.createdAt),
	],
)

export const paymentRelations = relations(payment, ({ one }) => ({
	organization: one(organization, {
		fields: [payment.organizationId],
		references: [organization.id],
	}),
}))
