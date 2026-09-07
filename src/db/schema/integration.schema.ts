import { relations, sql } from "drizzle-orm"
import { boolean, check, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

import { user } from "./auth.schema"

/**
 * An outside system an agent is allowed to reach, configured by a platform
 * administrator.
 *
 * Separate from `provider_credential` on purpose. That table holds the keys for
 * the models Ragenta runs; this one holds keys for systems a *customer's agent*
 * acts on — a search API, their CRM, an internal service. The two have different
 * blast radii and different people should be able to reason about them apart.
 *
 * **The allowlist is the security boundary, not the prompt.** An agent can call
 * only an integration that exists here, only with a method listed here, and only
 * under the path prefix listed here. None of those come from the model, from the
 * agent's configuration, or from anything a document told the model to do — which
 * is the whole point, because a fetched web page can and will try
 * (`.claude/rules/security.md`).
 */
export const integration = pgTable(
	"integration",
	{
		/** Stable id an agent's tool names, e.g. `tavily` or `crm`. */
		id: text("id").primaryKey(),
		/** web_search | http_api | email */
		kind: text("kind").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		/** Off keeps the row and its key while making every call through it refuse. */
		enabled: boolean("enabled").default(true).notNull(),

		/** Where calls go. Required for `http_api`; the others have a fixed host. */
		baseUrl: text("base_url"),

		/**
		 * AES-256-GCM ciphertext, read only when a call is made and never selected
		 * into an API response. `secret_hint` is the masked form that is safe to
		 * show, exactly as `provider_credential` does it (ADR-021).
		 */
		encryptedSecret: text("encrypted_secret"),
		secretHint: text("secret_hint"),

		/** Header the secret goes in, e.g. `Authorization` or `X-Api-Key`. */
		authHeader: text("auth_header"),
		/** Prefix before the secret in that header, e.g. `Bearer `. */
		authPrefix: text("auth_prefix").default("").notNull(),

		/**
		 * What an agent may do through this integration. Both are hard limits: a
		 * connection configured read-only cannot be talked into a POST, whatever
		 * the model decides it wants.
		 */
		allowedMethods: jsonb("allowed_methods").$type<string[]>().default(["GET"]).notNull(),
		/** Every request path must start with this. Empty allows the whole host. */
		allowedPathPrefix: text("allowed_path_prefix").default("").notNull(),
		/**
		 * Addresses `send_email` may write to. Empty means the tool refuses every
		 * recipient — an email integration with no allowlist is one nobody has
		 * decided the scope of yet, and defaulting that to "anyone" would be the
		 * wrong way round.
		 */
		allowedRecipients: jsonb("allowed_recipients").$type<string[]>().default([]).notNull(),

		lastUsedAt: timestamp("last_used_at"),
		lastCheckedAt: timestamp("last_checked_at"),
		lastCheckOk: boolean("last_check_ok"),
		/** The far side's own failure message. Never contains the secret. */
		lastCheckError: text("last_check_error"),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
	},
	(table) => [
		check("integration_kind_check", sql`${table.kind} in ('web_search', 'http_api', 'email')`),
	],
)

export const integrationRelations = relations(integration, ({ one }) => ({
	updatedByUser: one(user, { fields: [integration.updatedBy], references: [user.id] }),
}))
