import { relations, sql } from "drizzle-orm"
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

import { user } from "./auth.schema"
import { member, organization } from "./workspace.schema"

/**
 * A key a program authenticates with, instead of a person's session.
 *
 * `CLAUDE.md` has listed API access in the product scope since the workspace was
 * created and there has been no table for it. It arrives now rather than earlier
 * for a specific reason: a key should carry **a subset of what its creator may
 * do**, and that sentence was not expressible until permissions were rows
 * (ADR-046). Before that a key would have been all-or-nothing, which is the
 * design nobody can narrow afterwards.
 *
 * **Stored hashed, shown once.** It is a credential the caller presents, so it
 * is verified and never replayed — the same reasoning as a webhook secret
 * (ADR-058) and for the same reason SHA-256 with no work factor is right: it is
 * 32 random bytes we generated, so there is no dictionary to run against it, and
 * a slow hash would be paid on every request instead (ADR-062).
 */
export const apiKey = pgTable(
	"api_key",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),

		name: text("name").notNull(),
		/** SHA-256 of the presented key. The only copy that survives creation. */
		keyHash: text("key_hash").notNull(),
		/** `rag_a1b2…f9` — enough to tell two keys apart on a screen, not enough to use. */
		keyHint: text("key_hint").notNull(),

		/**
		 * The permissions this key may exercise.
		 *
		 * Checked as an **intersection** with what the granting membership still
		 * holds, not as an absolute grant. A key written by an admin who is later
		 * demoted must not keep doing admin things — a credential that outlives its
		 * author's authority is the thing an audit finds and nobody can explain.
		 */
		permissions: jsonb("permissions").$type<string[]>().default([]).notNull(),

		/**
		 * The membership the key acts through.
		 *
		 * A key is not a user: it authenticates as *this membership's* access to
		 * *this workspace*, which is what makes the intersection above possible and
		 * what makes a removed member's keys stop working — the row goes with them.
		 */
		memberId: text("member_id")
			.notNull()
			.references(() => member.id, { onDelete: "cascade" }),

		expiresAt: timestamp("expires_at"),
		revokedAt: timestamp("revoked_at"),
		/**
		 * Touched on use, deliberately without precision: the write is best effort
		 * and throttled, because a key used a thousand times a minute should not be
		 * a thousand writes to the same row.
		 */
		lastUsedAt: timestamp("last_used_at"),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
	},
	(table) => [
		check(
			"apiKey_expiry_check",
			sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.createdAt}`,
		),
		// The lookup every authenticated request makes.
		uniqueIndex("apiKey_keyHash_uidx").on(table.keyHash),
		index("apiKey_organizationId_idx").on(table.organizationId),
	],
)

export const apiKeyRelations = relations(apiKey, ({ one }) => ({
	organization: one(organization, {
		fields: [apiKey.organizationId],
		references: [organization.id],
	}),
	member: one(member, { fields: [apiKey.memberId], references: [member.id] }),
	creator: one(user, { fields: [apiKey.createdBy], references: [user.id] }),
}))
