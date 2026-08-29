import { relations } from "drizzle-orm"
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

import { user } from "./auth.schema"
import { organization } from "./workspace.schema"

/**
 * A project is where AI actually runs: it owns the agents, knowledge bases and
 * conversations that will hang off it, and it is the unit usage is attributed
 * to inside a workspace.
 *
 * Workspace is the tenant and the billing boundary; the project is the working
 * boundary. Usage rows carry both, so a workspace can answer "which project
 * spent the credits" without a second ledger.
 */
export const project = pgTable(
	"project",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		/** Unique within its workspace, not globally — it appears in workspace URLs. */
		slug: text("slug").notNull(),
		description: text("description"),
		/**
		 * Chat model override. Null means "inherit the workspace default", which
		 * is the normal case — storing a copy of the default would freeze the
		 * project on it the moment the workspace changed its mind.
		 */
		chatProvider: text("chat_provider"),
		chatModel: text("chat_model"),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
		/**
		 * Archived projects stay readable and keep their usage history. Deleting is
		 * a separate, owner-only action.
		 */
		archivedAt: timestamp("archived_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex("project_organizationId_slug_uidx").on(table.organizationId, table.slug),
		index("project_organizationId_createdAt_idx").on(table.organizationId, table.createdAt),
	],
)

export const projectRelations = relations(project, ({ one }) => ({
	organization: one(organization, {
		fields: [project.organizationId],
		references: [organization.id],
	}),
	creator: one(user, { fields: [project.createdBy], references: [user.id] }),
}))
