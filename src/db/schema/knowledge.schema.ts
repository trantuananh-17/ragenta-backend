import { relations, sql } from "drizzle-orm"
import {
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

import { user } from "./auth.schema"
import { project } from "./project.schema"
import { organization } from "./workspace.schema"

/**
 * A knowledge base: a set of documents that are retrieved together.
 *
 * It belongs to the **workspace**, not to a project (ADR-019). One team's
 * handbook is answered from by several projects, and a knowledge base that had
 * to be duplicated per project would be re-ingested and re-embedded per project
 * — the same documents, paid for twice, drifting apart.
 *
 * The embedding model is **frozen here at creation**. Vectors from two models
 * are not comparable, so changing it would not degrade retrieval, it would
 * silently return nonsense from whichever half of the index it happened to hit.
 * Re-embedding is a new knowledge base, or an explicit rebuild.
 */
export const knowledgeBase = pgTable(
	"knowledge_base",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		/** Unique within its workspace — it appears in workspace URLs. */
		slug: text("slug").notNull(),
		description: text("description"),

		embeddingProvider: text("embedding_provider").notNull(),
		embeddingModel: text("embedding_model").notNull(),
		/** Selects the Qdrant collection. Frozen with the model that produced it. */
		embeddingDimensions: integer("embedding_dimensions").notNull(),

		/**
		 * Chunking parameters, per knowledge base because the right size depends on
		 * the documents. 512 tokens with 15% overlap is RAGFlow's naive default and
		 * a reasonable starting point for prose.
		 */
		chunkTokenSize: integer("chunk_token_size").default(512).notNull(),
		chunkOverlapPercent: integer("chunk_overlap_percent").default(15).notNull(),

		/** Caches of `document` and `chunk`, maintained by the ingestion pipeline. */
		documentCount: integer("document_count").default(0).notNull(),
		chunkCount: integer("chunk_count").default(0).notNull(),

		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex("knowledgeBase_organizationId_slug_uidx").on(
			table.organizationId,
			table.slug,
		),
		index("knowledgeBase_organizationId_createdAt_idx").on(
			table.organizationId,
			table.createdAt,
		),
		check(
			"knowledgeBase_chunkOverlap_range",
			sql`${table.chunkOverlapPercent} >= 0 and ${table.chunkOverlapPercent} < 100`,
		),
	],
)

/**
 * An uploaded file and where its ingestion got to.
 *
 * `storage_key` is generated, never derived from the uploaded filename — a
 * filename is attacker-controlled and a path built from one is how a store ends
 * up with `../`. The display name is kept separately and is only ever rendered.
 *
 * `status` is a state machine the worker advances: pending → parsing → chunking
 * → embedding → ready, or → failed with a reason. It is on the row rather than
 * inferred from chunk counts, because "zero chunks" is both a document that
 * failed and a document that is genuinely empty.
 */
export const document = pgTable(
	"document",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		knowledgeBaseId: text("knowledge_base_id")
			.notNull()
			.references(() => knowledgeBase.id, { onDelete: "cascade" }),

		/** What the uploader called it. Display only — never used to build a path. */
		name: text("name").notNull(),
		/** Object key in the bucket. Generated from the document id. */
		storageKey: text("storage_key").notNull(),
		mimeType: text("mime_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),

		/** pending | parsing | chunking | embedding | ready | failed */
		status: text("status").default("pending").notNull(),
		/** Why it failed, in words the uploader can act on. Null once it succeeds. */
		error: text("error"),

		chunkCount: integer("chunk_count").default(0).notNull(),
		tokenCount: integer("token_count").default(0).notNull(),

		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		indexedAt: timestamp("indexed_at"),
	},
	(table) => [
		index("document_knowledgeBaseId_createdAt_idx").on(
			table.knowledgeBaseId,
			table.createdAt,
		),
		index("document_organizationId_status_idx").on(table.organizationId, table.status),
	],
)

/**
 * One retrievable passage.
 *
 * The text lives here and the vector lives in Qdrant, keyed by this row's id
 * (ADR-020). That split is deliberate: Postgres answers the lexical half of
 * hybrid retrieval and renders citations, Qdrant answers the dense half. Storing
 * the text in both would mean an edit could disagree with itself, and storing
 * vectors in Postgres would mean building an ANN index it does not have.
 */
export const chunk = pgTable(
	"chunk",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		knowledgeBaseId: text("knowledge_base_id")
			.notNull()
			.references(() => knowledgeBase.id, { onDelete: "cascade" }),
		documentId: text("document_id")
			.notNull()
			.references(() => document.id, { onDelete: "cascade" }),
		/** Position within the document, so a citation can be shown in context. */
		ordinal: integer("ordinal").notNull(),
		content: text("content").notNull(),
		tokenCount: integer("token_count").default(0).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("chunk_documentId_ordinal_uidx").on(table.documentId, table.ordinal),
		index("chunk_knowledgeBaseId_idx").on(table.knowledgeBaseId),
		/**
		 * The lexical half of retrieval. `simple` rather than `english`: a
		 * knowledge base is not guaranteed to be in English, and an English
		 * stemmer applied to Vietnamese text produces worse matches than no
		 * stemmer at all.
		 */
		index("chunk_content_fts_idx").using(
			"gin",
			sql`to_tsvector('simple', ${table.content})`,
		),
	],
)

/** A chat thread. Scoped to a workspace; a project and a knowledge base are optional. */
export const conversation = pgTable(
	"conversation",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: text("project_id").references(() => project.id, { onDelete: "set null" }),
		/**
		 * Null means the model answers without retrieval. Set null rather than
		 * cascade on delete: the conversation and its citations stay readable after
		 * the knowledge base is gone, which is what an audit of an answer needs.
		 */
		knowledgeBaseId: text("knowledge_base_id").references(() => knowledgeBase.id, {
			onDelete: "set null",
		}),
		title: text("title").notNull(),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
	},
	(table) => [
		index("conversation_organizationId_lastMessageAt_idx").on(
			table.organizationId,
			table.lastMessageAt,
		),
	],
)

/**
 * One turn. Citations are frozen JSON rather than foreign keys to `chunk`:
 * re-ingesting a document replaces its chunks, and an answer must keep showing
 * what it was actually built from, not what the same document says today.
 */
export const message = pgTable(
	"message",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		/** user | assistant */
		role: text("role").notNull(),
		content: text("content").notNull(),
		citations: jsonb("citations").$type<MessageCitation[]>().default([]).notNull(),

		provider: text("provider"),
		model: text("model"),
		inputTokens: integer("input_tokens").default(0).notNull(),
		outputTokens: integer("output_tokens").default(0).notNull(),
		credits: numeric("credits", { precision: 14, scale: 4 }).default("0").notNull(),

		/** streaming | complete | failed */
		status: text("status").default("complete").notNull(),
		error: text("error"),
		userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("message_conversationId_createdAt_idx").on(
			table.conversationId,
			table.createdAt,
		),
		check("message_role_check", sql`${table.role} in ('user', 'assistant')`),
	],
)

export interface MessageCitation {
	/** 1-based, matching the [[n]] marker in the answer text. */
	index: number
	chunkId: string
	documentId: string
	documentName: string
	snippet: string
	score: number
}

export const knowledgeBaseRelations = relations(knowledgeBase, ({ one, many }) => ({
	organization: one(organization, {
		fields: [knowledgeBase.organizationId],
		references: [organization.id],
	}),
	documents: many(document),
}))

export const documentRelations = relations(document, ({ one, many }) => ({
	knowledgeBase: one(knowledgeBase, {
		fields: [document.knowledgeBaseId],
		references: [knowledgeBase.id],
	}),
	chunks: many(chunk),
}))

export const chunkRelations = relations(chunk, ({ one }) => ({
	document: one(document, { fields: [chunk.documentId], references: [document.id] }),
	knowledgeBase: one(knowledgeBase, {
		fields: [chunk.knowledgeBaseId],
		references: [knowledgeBase.id],
	}),
}))

export const conversationRelations = relations(conversation, ({ one, many }) => ({
	organization: one(organization, {
		fields: [conversation.organizationId],
		references: [organization.id],
	}),
	project: one(project, { fields: [conversation.projectId], references: [project.id] }),
	knowledgeBase: one(knowledgeBase, {
		fields: [conversation.knowledgeBaseId],
		references: [knowledgeBase.id],
	}),
	messages: many(message),
}))

export const messageRelations = relations(message, ({ one }) => ({
	conversation: one(conversation, {
		fields: [message.conversationId],
		references: [conversation.id],
	}),
}))
