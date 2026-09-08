import { relations, sql } from "drizzle-orm"
import {
	check,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"

import { user } from "./auth.schema"
import { organization } from "./workspace.schema"

/**
 * An account somebody connected, so an agent can act as them in another system.
 *
 * Separate from `integration` on purpose, and this is the one place a second
 * credential table is right. An `integration` holds a key **the deployment
 * owns** and never expires; this holds a token **a person granted**, which
 * expires, refreshes, and can be revoked from the other end at any moment. The
 * two have different lifecycles and different failure modes — a key that stops
 * working is a misconfiguration, a token that stops working is somebody
 * withdrawing consent — and one table would mean the refresh path had to check
 * "does this row even have a refresh token" on every read (ADR-059).
 *
 * **Always workspace-scoped.** There is no platform-wide variant, unlike
 * `integration` and `mcp_server`: a connection is somebody's Gmail, and a
 * deployment-wide row would mean every tenant acting as one person.
 */
export const oauthConnection = pgTable(
	"oauth_connection",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** `google`, `slack`, `github`… — a key in the compiled provider registry. */
		provider: text("provider").notNull(),

		/**
		 * Who this is on the far side — an email, a workspace name, a handle.
		 *
		 * Stored because it is the only way a screen can say *which* account is
		 * connected. Two Gmail connections in one workspace are ordinary, and
		 * "Google" on both rows tells nobody which one to revoke.
		 */
		accountLabel: text("account_label").notNull(),
		/** The far side's own id for that account, for detecting a reconnect. */
		externalAccountId: text("external_account_id"),

		/** What was actually granted, which is not always what was asked for. */
		scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),

		/**
		 * AES-256-GCM ciphertext. Never selected into an API response, never
		 * logged, and read only when a call is about to be made (ADR-021).
		 */
		encryptedAccessToken: text("encrypted_access_token").notNull(),
		/**
		 * Null when the provider issued none — some do not, and some only issue one
		 * on the first authorization. A connection with no refresh token is one that
		 * will need reconnecting when it expires, and the screen should say so
		 * rather than discovering it at the moment an agent needed it.
		 */
		encryptedRefreshToken: text("encrypted_refresh_token"),
		/** When the access token stops working. Null means the provider did not say. */
		expiresAt: timestamp("expires_at"),

		/** active | expired | revoked */
		status: text("status").default("active").notNull(),
		lastRefreshedAt: timestamp("last_refreshed_at"),
		/** The far side's own refusal, kept where somebody can read it. Never a token. */
		lastError: text("last_error"),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		/**
		 * Who granted it. `set null` rather than cascade: a departed colleague's
		 * account going away must not silently delete a connection the team's agents
		 * still run on — that is a decision somebody makes, not a side effect.
		 */
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
	},
	(table) => [
		check(
			"oauthConnection_status_check",
			sql`${table.status} in ('active', 'expired', 'revoked')`,
		),
		// One connection per (workspace, provider, account). Reconnecting the same
		// account replaces its tokens instead of leaving a stale row that a tool
		// might pick and fail on.
		uniqueIndex("oauthConnection_workspace_provider_account_uidx").on(
			table.organizationId,
			table.provider,
			table.externalAccountId,
		),
		index("oauthConnection_organizationId_provider_idx").on(
			table.organizationId,
			table.provider,
		),
	],
)

export const oauthConnectionRelations = relations(oauthConnection, ({ one }) => ({
	organization: one(organization, {
		fields: [oauthConnection.organizationId],
		references: [organization.id],
	}),
	grantedBy: one(user, { fields: [oauthConnection.createdBy], references: [user.id] }),
}))
