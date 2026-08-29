import { relations } from "drizzle-orm"
import {
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"

import { user } from "./auth.schema"
import { project } from "./project.schema"
import { organization } from "./workspace.schema"

/**
 * Append-only record of what an AI operation actually consumed, in the
 * provider's own units, next to the credits it was charged.
 *
 * Two ledgers on purpose. `credit_transaction` answers "what happened to the
 * balance" and is the billing truth. This one answers "why" — which model, whose
 * request, how many tokens — and is what the usage screens and any future
 * per-model pricing analysis read.
 *
 * They are written in the same transaction and share `reference`, so neither can
 * exist without the other.
 *
 * Explicitly NOT a mutable `used_tokens` counter on a settings row: a counter
 * cannot be audited, cannot be attributed to a project or a user, and cannot be
 * recomputed if it drifts.
 */
export const usageLedger = pgTable(
	"usage_ledger",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** Null for workspace-level operations that belong to no project. */
		projectId: text("project_id").references(() => project.id, { onDelete: "set null" }),
		/** Null when a job, not a person, caused the spend. */
		userId: text("user_id").references(() => user.id, { onDelete: "set null" }),

		/** chat | embedding | rerank | ingestion | agent */
		operation: text("operation").notNull(),
		provider: text("provider").notNull(),
		model: text("model").notNull(),

		inputTokens: integer("input_tokens").default(0).notNull(),
		outputTokens: integer("output_tokens").default(0).notNull(),
		embeddingTokens: integer("embedding_tokens").default(0).notNull(),

		/**
		 * Credits charged for this row, computed from the token counts at write
		 * time. Frozen deliberately: a later price change must not silently
		 * restate what a customer was already billed.
		 */
		credits: numeric("credits", { precision: 14, scale: 4 }).notNull(),
		/** The pricing table version this row was priced with. */
		pricingVersion: text("pricing_version").notNull(),

		/** Shared with the matching credit_transaction rows. */
		reference: text("reference").notNull(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("usageLedger_organizationId_createdAt_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("usageLedger_organizationId_projectId_createdAt_idx").on(
			table.organizationId,
			table.projectId,
			table.createdAt,
		),
		uniqueIndex("usageLedger_reference_uidx").on(table.reference),
	],
)

export const usageLedgerRelations = relations(usageLedger, ({ one }) => ({
	organization: one(organization, {
		fields: [usageLedger.organizationId],
		references: [organization.id],
	}),
	project: one(project, { fields: [usageLedger.projectId], references: [project.id] }),
	user: one(user, { fields: [usageLedger.userId], references: [user.id] }),
}))
