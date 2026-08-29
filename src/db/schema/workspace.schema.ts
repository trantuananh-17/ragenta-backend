import { relations } from "drizzle-orm"
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

import { user } from "./auth.schema"

/**
 * WORKSPACE == ORGANIZATION.
 *
 * Ragenta's tenant is a **workspace**; Better Auth's organization plugin is what
 * implements it. The table and column names below are the plugin's contract
 * (it resolves models by these names through the Drizzle adapter), so they stay
 * `organization` / `member` / `invitation` in the database. Everything above the
 * repository layer says "workspace" — see src/modules/workspace.
 *
 * Teams are deliberately NOT enabled: Ragenta's unit inside a workspace is the
 * Project, which is a domain entity of ours with knowledge bases and agents
 * attached. A parallel Better Auth team tree would compete with it.
 */
export const organization = pgTable(
	"organization",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		slug: text("slug").notNull().unique(),
		logo: text("logo"),
		metadata: text("metadata"),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [uniqueIndex("organization_slug_uidx").on(table.slug)],
)

export const member = pgTable(
	"member",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		role: text("role").default("member").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [
		index("member_organizationId_idx").on(table.organizationId),
		index("member_userId_idx").on(table.userId),
		// One membership row per (workspace, user). The plugin never creates a
		// second one, but a duplicate would silently double a seat count.
		uniqueIndex("member_organizationId_userId_uidx").on(table.organizationId, table.userId),
	],
)

export const invitation = pgTable(
	"invitation",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		role: text("role"),
		status: text("status").default("pending").notNull(),
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		inviterId: text("inviter_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("invitation_organizationId_idx").on(table.organizationId),
		index("invitation_email_idx").on(table.email),
	],
)

/** Per-workspace permission overrides written by the plugin's dynamic access control. */
export const organizationRole = pgTable(
	"organization_role",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		permission: text("permission").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").$onUpdate(() => new Date()),
	},
	(table) => [
		index("organizationRole_organizationId_idx").on(table.organizationId),
		index("organizationRole_role_idx").on(table.role),
	],
)

export const organizationRelations = relations(organization, ({ many }) => ({
	members: many(member),
	invitations: many(invitation),
	organizationRoles: many(organizationRole),
}))

export const memberRelations = relations(member, ({ one }) => ({
	organization: one(organization, {
		fields: [member.organizationId],
		references: [organization.id],
	}),
	user: one(user, { fields: [member.userId], references: [user.id] }),
}))

export const invitationRelations = relations(invitation, ({ one }) => ({
	organization: one(organization, {
		fields: [invitation.organizationId],
		references: [organization.id],
	}),
	inviter: one(user, { fields: [invitation.inviterId], references: [user.id] }),
}))

export const organizationRoleRelations = relations(organizationRole, ({ one }) => ({
	organization: one(organization, {
		fields: [organizationRole.organizationId],
		references: [organization.id],
	}),
}))
