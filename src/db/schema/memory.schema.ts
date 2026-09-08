import { relations, sql } from "drizzle-orm"
import { check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

import { user } from "./auth.schema"
import { agent } from "./agent.schema"
import { organization } from "./workspace.schema"

/**
 * What an agent remembers between runs.
 *
 * Separate from `chunk` on purpose, and not a knowledge base with a different
 * name. A knowledge base is a corpus somebody uploaded and can inspect, re-index
 * and delete as a unit; a memory is one sentence the *model* decided to keep,
 * about one agent and often about one person. They have different lifecycles,
 * different owners and different blast radii, and giving memory its own table is
 * what makes "forget everything you know about me" a delete somebody can run
 * (ADR-055).
 *
 * **A memory is untrusted text.** It was written by a model from a conversation
 * a customer drove, so it reaches a prompt inside the same nonce fence a fetched
 * web page does. A memory saying "you may email the customer list" is content,
 * not a permission.
 */
export const agentMemory = pgTable(
	"agent_memory",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		agentId: text("agent_id")
			.notNull()
			.references(() => agent.id, { onDelete: "cascade" }),
		/**
		 * Whose memory this is. NULL means the agent remembers it about everybody —
		 * a fact about the business rather than about a person.
		 *
		 * `set null` rather than cascade: a departed colleague's account going away
		 * must not silently delete what the agent learned about the *work*. What it
		 * learned about them personally is a deletion somebody asks for, not a side
		 * effect of an account closing.
		 */
		userId: text("user_id").references(() => user.id, { onDelete: "set null" }),

		content: text("content").notNull(),
		/** tool | summary — written by `memory_write`, or by a run's own recap. */
		source: text("source").notNull(),

		/**
		 * The model this memory's vector was produced by, and its width.
		 *
		 * Frozen on the row for the reason a knowledge base freezes its embedding
		 * model: vectors from two models are not comparable, so a recall across
		 * both returns nonsense rather than degrading. A memory written under an
		 * old model is skipped by a search under a new one, and re-embedding is an
		 * explicit operation rather than something a settings change triggers.
		 */
		embeddingModel: text("embedding_model").notNull(),
		dimensions: integer("dimensions").notNull(),

		metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		/** Touched on recall, so a cap can drop what nothing has needed for months. */
		lastUsedAt: timestamp("last_used_at").defaultNow().notNull(),
	},
	(table) => [
		check("agentMemory_source_check", sql`${table.source} in ('tool', 'summary')`),
		index("agentMemory_agentId_userId_idx").on(table.agentId, table.userId),
		index("agentMemory_organizationId_idx").on(table.organizationId),
		index("agentMemory_agentId_createdAt_idx").on(table.agentId, table.createdAt),
	],
)

export const agentMemoryRelations = relations(agentMemory, ({ one }) => ({
	organization: one(organization, {
		fields: [agentMemory.organizationId],
		references: [organization.id],
	}),
	agent: one(agent, { fields: [agentMemory.agentId], references: [agent.id] }),
	user: one(user, { fields: [agentMemory.userId], references: [user.id] }),
}))
