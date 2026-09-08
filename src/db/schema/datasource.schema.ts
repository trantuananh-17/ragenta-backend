import { relations, sql } from "drizzle-orm"
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"

import { user } from "./auth.schema"
import { organization } from "./workspace.schema"

/**
 * A customer's own database, and the questions an agent may ask it.
 *
 * Two tables rather than one, and the split is the security design (ADR-064).
 * `data_source` is the connection; `data_query` is a **named, approved
 * question**. An agent can call the second and can never write SQL of its own,
 * so injection and exfiltration are removed by construction rather than caught
 * by validation.
 */
export const dataSource = pgTable(
	"data_source",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),

		/** What an agent's tool description calls it: "the shop database". */
		name: text("name").notNull(),
		/** postgres | mysql */
		engine: text("engine").notNull(),

		/**
		 * AES-256-GCM ciphertext of the whole connection string, read only when a
		 * query runs and never selected into an API response (ADR-021).
		 *
		 * **The credential must belong to a read-only database user.** That is
		 * stated in the UI and enforced by the driver where it can be — a
		 * `SET TRANSACTION READ ONLY` on Postgres — but the durable guarantee is
		 * the grant on the customer's side, because a connection with write rights
		 * is one mistake away from a `DELETE` whatever this code does.
		 */
		encryptedDsn: text("encrypted_dsn").notNull(),
		/** `postgres://…@db.example.com/shop` with the password removed. */
		dsnHint: text("dsn_hint").notNull(),

		enabled: boolean("enabled").default(true).notNull(),

		/**
		 * The schema as it was last read, for the screen and for generation.
		 *
		 * Cached because introspection is a round trip to somebody else's database
		 * and the authoring screen reads it on every keystroke's worth of thinking.
		 * Stale is visible: the screen shows when it was read and offers to refresh.
		 */
		schemaCache: jsonb("schema_cache").$type<DataSourceTable[]>().default([]).notNull(),
		schemaCachedAt: timestamp("schema_cached_at"),

		lastCheckedAt: timestamp("last_checked_at"),
		lastCheckOk: boolean("last_check_ok"),
		/** The database's own refusal. Never contains the password. */
		lastCheckError: text("last_check_error"),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
	},
	(table) => [
		check("dataSource_engine_check", sql`${table.engine} in ('postgres', 'mysql')`),
		uniqueIndex("dataSource_organizationId_name_uidx").on(table.organizationId, table.name),
		index("dataSource_organizationId_idx").on(table.organizationId),
	],
)

/** One table as introspection found it. Stored verbatim; shown, never executed. */
export interface DataSourceTable {
	schema: string
	name: string
	columns: { name: string; type: string; nullable: boolean }[]
}

/**
 * A question somebody approved.
 *
 * **This is the only SQL an agent can cause to run.** The model picks a `name`
 * and supplies `parameters`; it never sees `sql` and never composes one. A query
 * reaches this table one of two ways — typed by somebody who writes SQL, or
 * proposed by a model from a plain-language description and then **approved by a
 * person who saw it run** (ADR-064).
 *
 * `approved_at` is null until that happens, and an unapproved query is invisible
 * to every agent. That column is the whole gate.
 */
export const dataQuery = pgTable(
	"data_query",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		dataSourceId: text("data_source_id")
			.notNull()
			.references(() => dataSource.id, { onDelete: "cascade" }),

		/** What the model calls it: `order_status`. Lower-case, dash-free. */
		name: text("name").notNull(),
		/**
		 * What the model is told this question answers. It is the whole of the
		 * tool's documentation for this query, so a vague one gets called wrongly.
		 */
		description: text("description").notNull(),

		/**
		 * The statement, with `$1`-style placeholders on Postgres and `?` on MySQL.
		 *
		 * Never interpolated — the driver binds the parameters, which is what makes
		 * a value containing `'; DROP TABLE` a string rather than a statement.
		 */
		sql: text("sql").notNull(),
		/** Each placeholder in order: what it is called and what it means. */
		parameters: jsonb("parameters").$type<DataQueryParameter[]>().default([]).notNull(),

		/** Rows one call may return. Bounded so an answer cannot become a dump. */
		rowLimit: integer("row_limit").default(50).notNull(),

		/** How it came to exist: `manual` or `generated`. Shown, and audited. */
		origin: text("origin").default("manual").notNull(),
		/**
		 * When a person approved it. **Null means no agent may call it.**
		 *
		 * A generated query starts null by definition. A hand-written one is
		 * approved by the act of saving it, because the person who wrote the SQL is
		 * the person reviewing it.
		 */
		approvedAt: timestamp("approved_at"),
		approvedBy: text("approved_by").references(() => user.id, { onDelete: "set null" }),

		lastRunAt: timestamp("last_run_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
	},
	(table) => [
		check("dataQuery_origin_check", sql`${table.origin} in ('manual', 'generated')`),
		check("dataQuery_rowLimit_check", sql`${table.rowLimit} between 1 and 500`),
		uniqueIndex("dataQuery_dataSourceId_name_uidx").on(table.dataSourceId, table.name),
		index("dataQuery_organizationId_idx").on(table.organizationId),
	],
)

export interface DataQueryParameter {
	name: string
	/** text | number | boolean — what the model is told to supply. */
	type: "text" | "number" | "boolean"
	description: string
}

export const dataSourceRelations = relations(dataSource, ({ one, many }) => ({
	organization: one(organization, {
		fields: [dataSource.organizationId],
		references: [organization.id],
	}),
	queries: many(dataQuery),
}))

export const dataQueryRelations = relations(dataQuery, ({ one }) => ({
	dataSource: one(dataSource, {
		fields: [dataQuery.dataSourceId],
		references: [dataSource.id],
	}),
	organization: one(organization, {
		fields: [dataQuery.organizationId],
		references: [organization.id],
	}),
}))
