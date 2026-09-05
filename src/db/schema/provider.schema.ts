import { relations, sql } from "drizzle-orm"
import {
	boolean,
	check,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"

import { user } from "./auth.schema"

/**
 * The API key Ragenta calls a provider with, one row per provider.
 *
 * Platform-level, not per workspace (ADR-016): Ragenta pays for inference and
 * customers spend credits, so a workspace never supplies a credential. What
 * changed from the original design is only *where* the key lives — an
 * environment variable meant rotating one required a redeploy, and adding a
 * provider required a code change.
 *
 * `encrypted_key` is AES-256-GCM ciphertext and is never selected into an API
 * response. `key_hint` is the only thing a screen may show, and it is stored
 * separately so answering "which key is this" never needs the plaintext.
 *
 * The `last_check_*` columns are the result of the most recent live call to the
 * provider. Kept here rather than derived on read because checking costs a
 * network round trip and money, so it happens when somebody asks for it.
 */
export const providerCredential = pgTable("provider_credential", {
	provider: text("provider").primaryKey(),
	encryptedKey: text("encrypted_key").notNull(),
	/** Masked form, e.g. `sk-ant-...9f31`. Safe to return; the key never is. */
	keyHint: text("key_hint").notNull(),
	/** Overrides the provider's default host — Azure, a gateway, a self-hosted model server. */
	baseUrl: text("base_url"),
	lastCheckedAt: timestamp("last_checked_at"),
	lastCheckOk: boolean("last_check_ok"),
	/** Provider-side failure message from the last check. Never contains the key. */
	lastCheckError: text("last_check_error"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
	updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
})

/**
 * A model the deployment offers, over and above the ones compiled into
 * `src/ai/models.ts`.
 *
 * The built-in list stays the source: it ships with the code, so a fresh
 * database is already usable. A row here is a complete definition that
 * *replaces* the built-in one with the same `(provider, model)` key, or adds a
 * model the code does not know about. One rule, one merge — see
 * `src/ai/catalogue.ts`.
 *
 * Rates are stored, not looked up, because they are what usage is priced on.
 * A model whose rates are wrong bills wrongly; a model with no rates at all
 * would be free, so they are required.
 */
export const providerModel = pgTable(
	"provider_model",
	{
		id: text("id").primaryKey(),
		provider: text("provider").notNull(),
		/** The provider's own model id, exactly as their API spells it. */
		model: text("model").notNull(),
		/** chat | embedding */
		capability: text("capability").notNull(),
		/** economy | premium — which plans may select it. */
		tier: text("tier").notNull(),
		contextWindow: integer("context_window"),
		inputPerMillion: numeric("input_per_million", { precision: 12, scale: 6 })
			.default("0")
			.notNull(),
		outputPerMillion: numeric("output_per_million", { precision: 12, scale: 6 })
			.default("0")
			.notNull(),
		embeddingPerMillion: numeric("embedding_per_million", { precision: 12, scale: 6 })
			.default("0")
			.notNull(),
		/**
		 * Vector width, for embedding models only. It decides which Qdrant
		 * collection a knowledge base indexes into, so a wrong value here does not
		 * degrade retrieval — it makes indexing fail outright, which is the safer
		 * of the two.
		 */
		embeddingDimensions: integer("embedding_dimensions"),
		/** Off hides it from every picker without losing its rates. */
		enabled: boolean("enabled").default(true).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex("providerModel_provider_model_uidx").on(table.provider, table.model),
		check(
			"providerModel_capability_check",
			sql`${table.capability} in ('chat', 'embedding')`,
		),
		check("providerModel_tier_check", sql`${table.tier} in ('economy', 'premium')`),
	],
)

/**
 * Platform-wide settings that have to be changeable without a deploy. One row
 * per key, value as JSON.
 *
 * Deliberately not a wide table of columns: the set of settings grows, and a
 * migration per new toggle is how a settings screen stops getting new toggles.
 * Every value is parsed with a schema on read (`src/modules/provider`), so the
 * looseness stops at the module boundary.
 */
export const platformSetting = pgTable("platform_setting", {
	key: text("key").primaryKey(),
	value: jsonb("value").$type<unknown>().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
	updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
})

export const providerCredentialRelations = relations(providerCredential, ({ one }) => ({
	editor: one(user, { fields: [providerCredential.updatedBy], references: [user.id] }),
}))

export const providerModelRelations = relations(providerModel, ({ one }) => ({
	creator: one(user, { fields: [providerModel.createdBy], references: [user.id] }),
}))
