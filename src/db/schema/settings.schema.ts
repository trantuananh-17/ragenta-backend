import { relations } from "drizzle-orm"
import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

import { organization } from "./workspace.schema"

/**
 * Per-workspace defaults for running AI.
 *
 * Only a *selection* is stored — never a credential. Ragenta pays for inference,
 * so provider API keys are server secrets in the environment
 * (`src/ai/providers.ts`) and nothing a client sends can influence which key is
 * used.
 *
 * The embedding model is a **default for new knowledge bases**, not a live
 * setting: changing it cannot re-embed what is already indexed, so a knowledge
 * base will freeze its own embedding model at creation time. Chat model, by
 * contrast, can change at any moment and a project may override it.
 */
export const workspaceSettings = pgTable("workspace_settings", {
	organizationId: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	chatProvider: text("chat_provider").notNull(),
	chatModel: text("chat_model").notNull(),
	embeddingProvider: text("embedding_provider").notNull(),
	embeddingModel: text("embedding_model").notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
})

export const workspaceSettingsRelations = relations(workspaceSettings, ({ one }) => ({
	organization: one(organization, {
		fields: [workspaceSettings.organizationId],
		references: [organization.id],
	}),
}))
