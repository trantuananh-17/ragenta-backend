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
} from "drizzle-orm/pg-core"

import { user } from "./auth.schema"
import { organization } from "./workspace.schema"

/**
 * Somewhere a workspace wants to be told when something happened here.
 *
 * The mirror of `agent_trigger`: that one is somebody else calling us, this one
 * is us calling somebody else. They are separate tables rather than one with a
 * direction column because almost nothing about them is shared — an inbound
 * trigger holds a credential it *verifies*, an outbound endpoint holds one it
 * *presents*, and those two are stored differently for that reason (ADR-067).
 */
export const webhookEndpoint = pgTable(
	"webhook_endpoint",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),

		name: text("name").notNull(),
		url: text("url").notNull(),
		enabled: boolean("enabled").default(true).notNull(),

		/**
		 * The signing secret, **encrypted rather than hashed**.
		 *
		 * The opposite of every other credential in this schema, and deliberately:
		 * this one is not presented to us, it is used *by* us to sign a body the
		 * receiver verifies. Signing needs the bytes back, so a hash would make the
		 * feature impossible. It never leaves the server — the API returns the hint
		 * and the plaintext exactly once, when it is created or rotated.
		 */
		encryptedSecret: text("encrypted_secret").notNull(),
		secretHint: text("secret_hint").notNull(),

		/**
		 * Which events this endpoint is sent, by key.
		 *
		 * An empty list means **nothing**, not everything — the inverse of the MCP
		 * tool allowlist, and inverted on purpose. There, an empty list is a
		 * permission that quietly widens; here it would be a subscription that
		 * quietly widens, sending a customer's server payloads it has never seen a
		 * schema for. Both defaults are the narrow one.
		 */
		events: jsonb("events").$type<string[]>().default([]).notNull(),

		/**
		 * Consecutive failed deliveries, and when the endpoint was switched off for
		 * it.
		 *
		 * An endpoint whose host has been gone for a week is one we are paying to
		 * retry into a void, and every retry is a queue slot a working endpoint
		 * could have used. It is disabled rather than deleted so somebody can see
		 * why it stopped and turn it back on.
		 */
		failureCount: integer("failure_count").default(0).notNull(),
		disabledAt: timestamp("disabled_at"),
		lastDeliveryAt: timestamp("last_delivery_at"),
		lastError: text("last_error"),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
	},
	(table) => [
		index("webhookEndpoint_organizationId_idx").on(table.organizationId),
		// The fan-out's own read: enabled endpoints for one workspace.
		index("webhookEndpoint_enabled_idx").on(table.organizationId, table.enabled),
	],
)

/**
 * One attempt to deliver one event, kept whether it worked or not.
 *
 * The failed ones are the point. "We sent it" and "your server 500ed twice and
 * then took it" are different stories, and without the row the second is
 * indistinguishable from the first — which is how an integration argument
 * becomes unresolvable.
 */
export const webhookDelivery = pgTable(
	"webhook_delivery",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		endpointId: text("endpoint_id")
			.notNull()
			.references(() => webhookEndpoint.id, { onDelete: "cascade" }),

		event: text("event").notNull(),
		/** What was signed and sent, so a replay sends the same bytes. */
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),

		/** pending | succeeded | failed */
		status: text("status").default("pending").notNull(),
		/** Which attempt this row records. 1 is the first. */
		attempt: integer("attempt").default(1).notNull(),
		/** The receiver's status, where it answered at all. */
		responseStatus: integer("response_status"),
		/** The receiver's own words, capped. Evidence, not a log line. */
		responseBody: text("response_body"),
		error: text("error"),
		durationMs: integer("duration_ms"),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		deliveredAt: timestamp("delivered_at"),
	},
	(table) => [
		check(
			"webhookDelivery_status_check",
			sql`${table.status} in ('pending', 'succeeded', 'failed')`,
		),
		// The two reads: an endpoint's own history, and a workspace's whole log.
		index("webhookDelivery_endpointId_createdAt_idx").on(
			table.endpointId,
			table.createdAt,
		),
		index("webhookDelivery_organizationId_createdAt_idx").on(
			table.organizationId,
			table.createdAt,
		),
	],
)

export const webhookEndpointRelations = relations(webhookEndpoint, ({ one, many }) => ({
	organization: one(organization, {
		fields: [webhookEndpoint.organizationId],
		references: [organization.id],
	}),
	deliveries: many(webhookDelivery),
}))

export const webhookDeliveryRelations = relations(webhookDelivery, ({ one }) => ({
	endpoint: one(webhookEndpoint, {
		fields: [webhookDelivery.endpointId],
		references: [webhookEndpoint.id],
	}),
	organization: one(organization, {
		fields: [webhookDelivery.organizationId],
		references: [organization.id],
	}),
}))
