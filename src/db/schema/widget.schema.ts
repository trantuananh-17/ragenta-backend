import { relations, sql } from "drizzle-orm"
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"

import { agent } from "./agent.schema"
import { user } from "./auth.schema"
import { organization } from "./workspace.schema"

/**
 * A chat bubble on somebody else's website.
 *
 * This is the first thing in the product with **no session behind it**. A
 * visitor on a customer's shop is not a Ragenta member, has no account and never
 * will — so every control that protects the rest of the API is absent here, and
 * the columns below are what replaces them (ADR-065).
 */
export const chatWidget = pgTable(
	"chat_widget",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** Which agent answers. Its version decides the tools, the memory and the brief. */
		agentId: text("agent_id")
			.notNull()
			.references(() => agent.id, { onDelete: "cascade" }),

		name: text("name").notNull(),
		enabled: boolean("enabled").default(true).notNull(),

		/**
		 * `rgpk_…` — **publishable**, and that word is doing work.
		 *
		 * It sits in a `<script>` tag on a public page, so anybody can read it. It
		 * is stored in the clear rather than hashed for exactly that reason: there
		 * is no secret to protect, and hashing it would only make the lookup slower
		 * while implying a confidentiality it does not have.
		 */
		publicKey: text("public_key").notNull(),

		/**
		 * Where the widget may be embedded, as exact origins.
		 *
		 * **This stops the widget being embedded on the wrong site. It does not stop
		 * `curl`** — the `Origin` header is set by the caller — so it is a
		 * misconfiguration guard, not a spending guard. What guards the spending is
		 * every column below it.
		 */
		allowedOrigins: jsonb("allowed_origins").$type<string[]>().default([]).notNull(),

		/** First thing the visitor sees. Empty means the agent opens. */
		greeting: text("greeting").default("").notNull(),
		/** A hex colour for the launcher. Presentation only. */
		accentColor: text("accent_color").default("#7c3aed").notNull(),
		title: text("title").default("Chat").notNull(),

		/**
		 * The money guard: credits this widget may spend in a UTC day.
		 *
		 * Not a plan limit and not the workspace balance — its own ceiling, so one
		 * widget being found by a bot cannot empty a wallet the rest of the product
		 * runs on. Reached means the widget answers that it is unavailable, which is
		 * a bad hour rather than a bad month.
		 */
		dailyCreditCeiling: numeric("daily_credit_ceiling", { precision: 14, scale: 4 })
			.default("50000")
			.notNull(),
		/** Messages one visitor may send per hour. */
		visitorHourlyLimit: integer("visitor_hourly_limit").default(20).notNull(),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
	},
	(table) => [
		check("chatWidget_visitorLimit_check", sql`${table.visitorHourlyLimit} between 1 and 200`),
		// The lookup every visitor request makes, and the reason the key is a
		// column rather than a hash.
		uniqueIndex("chatWidget_publicKey_uidx").on(table.publicKey),
		uniqueIndex("chatWidget_organizationId_name_uidx").on(table.organizationId, table.name),
		index("chatWidget_organizationId_idx").on(table.organizationId),
	],
)

export const chatWidgetRelations = relations(chatWidget, ({ one }) => ({
	organization: one(organization, {
		fields: [chatWidget.organizationId],
		references: [organization.id],
	}),
	agent: one(agent, { fields: [chatWidget.agentId], references: [agent.id] }),
}))
