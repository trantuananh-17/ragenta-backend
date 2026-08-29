import { relations } from "drizzle-orm"
import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"

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
