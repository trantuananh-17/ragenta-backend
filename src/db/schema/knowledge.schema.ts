import { relations, sql } from "drizzle-orm"
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	primaryKey,
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

		/**
		 * Which chunking strategy the documents here are cut with — RAGFlow's
		 * `parser_id`. A document may override it, because one scanned appendix in
		 * an otherwise uniform base is not a reason for a second knowledge base.
		 */
		parserId: text("parser_id").default("general").notNull(),
		/** The strategy's knobs. Shape and defaults live in `parsers/index.ts`. */
		parserConfig: jsonb("parser_config").$type<Record<string, unknown>>().default({}).notNull(),

		/**
		 * Retrieval defaults, here rather than compiled in, because the right
		 * threshold depends on the documents. RAGFlow keeps the same three on its
		 * assistant; a conversation may override each of them for one thread.
		 */
		topK: integer("top_k").default(6).notNull(),
		similarityThreshold: numeric("similarity_threshold", { precision: 4, scale: 3 })
			.default("0.200")
			.notNull(),
		vectorWeight: numeric("vector_weight", { precision: 4, scale: 3 })
			.default("0.700")
			.notNull(),

		/** Optional second-stage reranker. Null means fusion alone decides the order. */
		rerankProvider: text("rerank_provider"),
		rerankModel: text("rerank_model"),

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

		/** pending | parsing | chunking | embedding | enriching | summarising | ready | failed | cancelled */
		status: text("status").default("pending").notNull(),
		/** Why it failed, in words the uploader can act on. Null once it succeeds. */
		error: text("error"),

		/** Overrides the knowledge base's strategy for this file only. Null inherits. */
		parserId: text("parser_id"),
		parserConfig: jsonb("parser_config").$type<Record<string, unknown>>(),

		/**
		 * 0..1, and the message beside it. RAGFlow's `progress` / `progress_msg`,
		 * and worth copying for the same reason: without them a large upload is a
		 * spinner that lasts four minutes, and a failure is a status with no story.
		 */
		progress: numeric("progress", { precision: 5, scale: 4 }).default("0").notNull(),
		progressMessage: text("progress_message"),

		/**
		 * A stop request, honoured between stages. Not a kill: a worker mid-way
		 * through an embedding call finishes it and stops after, because abandoning
		 * a provider call that has already been paid for saves nothing.
		 */
		cancelRequested: boolean("cancel_requested").default(false).notNull(),

		processBeganAt: timestamp("process_began_at"),
		processDurationMs: integer("process_duration_ms"),
		/** Pages, for formats that have them. Drives how the work is split into tasks. */
		pageCount: integer("page_count"),
		/** Incremented per re-index. Part of the job id, and of the credit reference. */
		attempt: integer("attempt").default(1).notNull(),

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

		/** passage | qa | row | summary — see `parsers/types.ts`. */
		kind: text("kind").default("passage").notNull(),
		/**
		 * Set only on a `qa` chunk. It is what gets embedded, ahead of the answer:
		 * a user's question matches another question far better than it matches
		 * the prose of an answer.
		 */
		question: text("question"),

		/**
		 * Model-written enrichment (RAGFlow's `auto_keywords` / `auto_questions`).
		 * Both are indexed for the lexical half and prepended to the embedding
		 * input, and neither is shown as part of the passage — they are a retrieval
		 * aid, not something the document said.
		 */
		keywords: text("keywords").array().default([]).notNull(),
		questions: text("questions").array().default([]).notNull(),

		/**
		 * RAPTOR tree level. 0 is a real passage from the document; 1 and above are
		 * model-written summaries over a cluster of the level below, which is what
		 * lets a question about the whole document match something.
		 */
		level: integer("level").default(0).notNull(),
		parentChunkId: text("parent_chunk_id"),

		fromPage: integer("from_page"),
		toPage: integer("to_page"),

		/**
		 * Content hash. RAGFlow compares task digests on re-ingestion and reuses
		 * the chunks that did not change; this is the column that makes that
		 * comparison possible without re-embedding to find out.
		 */
		digest: text("digest"),

		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("chunk_documentId_ordinal_uidx").on(table.documentId, table.ordinal),
		index("chunk_knowledgeBaseId_idx").on(table.knowledgeBaseId),
		index("chunk_documentId_digest_idx").on(table.documentId, table.digest),
		/**
		 * The lexical half of retrieval. `simple` rather than `english`: a
		 * knowledge base is not guaranteed to be in English, and an English
		 * stemmer applied to Vietnamese text produces worse matches than no
		 * stemmer at all.
		 */
		index("chunk_content_fts_idx").using(
			"gin",
			sql`to_tsvector('simple', ${table.content} || ' ' || coalesce(${table.question}, '') || ' ' || array_to_string(${table.keywords}, ' ') || ' ' || array_to_string(${table.questions}, ' '))`,
		),
	],
)

/**
 * One bounded unit of ingestion work, and the record of what it produced.
 *
 * RAGFlow splits a document into tasks by page range and hashes the chunking
 * config plus `doc_id/from_page/to_page` into a `digest`; on a re-ingestion it
 * compares digests against the previous tasks and reuses the chunks that did not
 * change. Two things fall out of that and both are worth having:
 *
 *  - A 600-page manual becomes several bounded jobs instead of one job that may
 *    exceed any timeout, and a failure retries only the range that failed.
 *  - Re-indexing after changing one setting does not re-embed — and re-bill —
 *    the pages that setting did not affect.
 *
 * `raptor` is a task too, because it runs over the whole document after every
 * page range is in and has no page range of its own.
 */
export const ingestionTask = pgTable(
	"ingestion_task",
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

		/** parse | raptor */
		taskType: text("task_type").default("parse").notNull(),
		/** 1-based inclusive. Both null for a task with no page range. */
		fromPage: integer("from_page"),
		toPage: integer("to_page"),

		/**
		 * Hash of the parser, its config and this page range. Equal digests mean
		 * equal output, which is what makes reuse safe rather than optimistic.
		 */
		digest: text("digest").notNull(),

		/** pending | running | done | failed | reused | cancelled */
		status: text("status").default("pending").notNull(),
		progress: numeric("progress", { precision: 5, scale: 4 }).default("0").notNull(),
		progressMessage: text("progress_message"),
		error: text("error"),
		retryCount: integer("retry_count").default(0).notNull(),
		chunkCount: integer("chunk_count").default(0).notNull(),

		/** Which re-index produced this row. Old attempts are deleted, not kept. */
		attempt: integer("attempt").default(1).notNull(),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		startedAt: timestamp("started_at"),
		finishedAt: timestamp("finished_at"),
	},
	(table) => [
		index("ingestionTask_documentId_attempt_idx").on(table.documentId, table.attempt),
		index("ingestionTask_digest_idx").on(table.digest),
		check(
			"ingestionTask_taskType_check",
			sql`${table.taskType} in ('parse', 'raptor')`,
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

		/**
		 * hybrid | vector | keyword. RAGFlow exposes the same choice, and each mode
		 * is right somewhere: vector for a question phrased in the asker's own
		 * words, keyword for an error code or a part number, hybrid for the rest.
		 */
		searchMode: text("search_mode").default("hybrid").notNull(),
		/** Null inherits the knowledge base's value. Set only when a thread differs. */
		topK: integer("top_k"),
		similarityThreshold: numeric("similarity_threshold", { precision: 4, scale: 3 }),
		vectorWeight: numeric("vector_weight", { precision: 4, scale: 3 }),
		rerankProvider: text("rerank_provider"),
		rerankModel: text("rerank_model"),

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
		check(
			"conversation_searchMode_check",
			sql`${table.searchMode} in ('hybrid', 'vector', 'keyword')`,
		),
	],
)

/**
 * The knowledge bases a conversation retrieves from, when it is more than one.
 *
 * RAGFlow's assistant holds `kb_ids` and searches them together, which is the
 * right shape — a question about onboarding may be answered by the handbook and
 * the benefits policy, and forcing the user to guess which is not a product.
 *
 * `conversation.knowledge_base_id` stays as the primary base: it is what a
 * single-base thread uses, it is what the citations survive against once a base
 * is deleted, and it is what every conversation created before this table had.
 * A row here is an *additional* base.
 *
 * Every base in one conversation must share an embedding model. Vectors from two
 * models are not comparable, so a mixed set would not degrade retrieval, it
 * would rank nonsense — `chatService` refuses the combination rather than
 * letting the constraint live only in a comment.
 */
export const conversationKnowledgeBase = pgTable(
	"conversation_knowledge_base",
	{
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		knowledgeBaseId: text("knowledge_base_id")
			.notNull()
			.references(() => knowledgeBase.id, { onDelete: "cascade" }),
	},
	(table) => [
		primaryKey({ columns: [table.conversationId, table.knowledgeBaseId] }),
		index("conversationKnowledgeBase_knowledgeBaseId_idx").on(table.knowledgeBaseId),
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
	/**
	 * passage | qa | row | summary. A reader is entitled to know that a citation
	 * points at a model-written summary rather than at something the document
	 * says, and only this field can tell them.
	 */
	kind?: string
	fromPage?: number | null
	toPage?: number | null
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

export const ingestionTaskRelations = relations(ingestionTask, ({ one }) => ({
	document: one(document, {
		fields: [ingestionTask.documentId],
		references: [document.id],
	}),
	knowledgeBase: one(knowledgeBase, {
		fields: [ingestionTask.knowledgeBaseId],
		references: [knowledgeBase.id],
	}),
}))

export const conversationKnowledgeBaseRelations = relations(
	conversationKnowledgeBase,
	({ one }) => ({
		conversation: one(conversation, {
			fields: [conversationKnowledgeBase.conversationId],
			references: [conversation.id],
		}),
		knowledgeBase: one(knowledgeBase, {
			fields: [conversationKnowledgeBase.knowledgeBaseId],
			references: [knowledgeBase.id],
		}),
	}),
)
