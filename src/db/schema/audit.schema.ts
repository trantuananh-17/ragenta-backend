import { relations } from "drizzle-orm"
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

import { user } from "./auth.schema"
import { organization } from "./workspace.schema"

/**
 * Append-only record of security- and money-relevant actions: member role
 * changes, invitations, credit adjustments, admin operations. Never updated,
 * never deleted by application code.
 *
 * `actorId` is nullable and set null on user delete so the trail survives the
 * account it describes.
 */
export const auditLog = pgTable(
	"audit_log",
	{
		id: text("id").primaryKey(),
		actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
		organizationId: text("organization_id").references(() => organization.id, {
			onDelete: "set null",
		}),
		/** Dotted verb, e.g. `workspace.member.role_changed`. */
		action: text("action").notNull(),
		/** Type and id of what was acted on, e.g. `member` / `mem_123`. */
		targetType: text("target_type"),
		targetId: text("target_id"),
		status: text("status").default("success").notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("auditLog_organizationId_createdAt_idx").on(table.organizationId, table.createdAt),
		index("auditLog_actorId_idx").on(table.actorId),
		index("auditLog_action_idx").on(table.action),
	],
)

export const auditLogRelations = relations(auditLog, ({ one }) => ({
	actor: one(user, { fields: [auditLog.actorId], references: [user.id] }),
	organization: one(organization, {
		fields: [auditLog.organizationId],
		references: [organization.id],
	}),
}))
