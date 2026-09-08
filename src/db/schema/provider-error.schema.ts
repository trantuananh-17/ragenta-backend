import { relations, sql } from "drizzle-orm"
import { check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"

import { organization } from "./workspace.schema"

/**
 * A provider call that failed.
 *
 * The gap `agent_run_step` does not cover: a chat turn that a provider refused
 * before the stream opened, an embedding call that came back 429, a rerank that
 * timed out. Each is logged and then gone, so "why did that stop working on
 * Tuesday" has no evidence behind it (ADR-063).
 *
 * **Failures only, deliberately.** A row per successful call would grow with
 * traffic and duplicate `usage_ledger`, which already records every call that
 * produced something. This table's size grows with what is *wrong*, which is the
 * property that keeps it readable — and a table nobody can read is one nobody
 * looks at.
 */
export const providerError = pgTable(
	"provider_error",
	{
		id: text("id").primaryKey(),
		/** Null for a call with no workspace behind it — a platform check, say. */
		organizationId: text("organization_id").references(() => organization.id, {
			onDelete: "cascade",
		}),

		provider: text("provider").notNull(),
		model: text("model"),
		/** chat | embedding | rerank | ingestion | agent | speech | vision */
		operation: text("operation").notNull(),

		/** The HTTP status, where there was one. Null for a timeout or a socket error. */
		status: integer("status"),
		/**
		 * The provider's own message, capped.
		 *
		 * Never a key: these come from a response body, and the one place a key
		 * could appear — an echoed Authorization header — is not something any of
		 * these providers do. Capped anyway, because a provider that returns an
		 * HTML error page would otherwise store the page.
		 */
		message: text("message").notNull(),
		durationMs: integer("duration_ms"),

		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		check(
			"providerError_operation_check",
			sql`${table.operation} in ('chat', 'embedding', 'rerank', 'ingestion', 'agent', 'speech', 'vision')`,
		),
		// The two reads: what is failing now, and what has been failing for a
		// workspace. Both are date-ordered, which is what the index carries.
		index("providerError_createdAt_idx").on(table.createdAt),
		index("providerError_provider_createdAt_idx").on(table.provider, table.createdAt),
		index("providerError_organizationId_createdAt_idx").on(
			table.organizationId,
			table.createdAt,
		),
	],
)

export const providerErrorRelations = relations(providerError, ({ one }) => ({
	organization: one(organization, {
		fields: [providerError.organizationId],
		references: [organization.id],
	}),
}))
