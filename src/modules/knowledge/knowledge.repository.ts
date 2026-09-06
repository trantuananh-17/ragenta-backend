import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { chunk, document, ingestionTask, knowledgeBase } from "../../db/schema"
import type { PaginationQuery } from "../../shared/pagination"

export type KnowledgeBaseRow = typeof knowledgeBase.$inferSelect
export type DocumentRow = typeof document.$inferSelect
export type ChunkRow = typeof chunk.$inferSelect
export type IngestionTaskRow = typeof ingestionTask.$inferSelect
export type NewChunk = typeof chunk.$inferInsert

/**
 * Every method takes the workspace id and puts it in the WHERE clause, even
 * where the primary key alone would be unique. That is the tenant boundary
 * expressed where it cannot be forgotten: a handler that passes an id from the
 * URL gets nothing back unless the row belongs to the caller's workspace.
 */
export const knowledgeRepository = {
	async listBases(workspaceId: string, query: PaginationQuery, executor: DbExecutor = db) {
		const items = await executor
			.select()
			.from(knowledgeBase)
			.where(eq(knowledgeBase.organizationId, workspaceId))
			.orderBy(desc(knowledgeBase.createdAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor
			.select({ value: count() })
			.from(knowledgeBase)
			.where(eq(knowledgeBase.organizationId, workspaceId))

		return { items, total: totals?.value ?? 0 }
	},

	async findBase(workspaceId: string, baseId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(knowledgeBase)
			.where(
				and(
					eq(knowledgeBase.organizationId, workspaceId),
					eq(knowledgeBase.id, baseId),
				),
			)
			.limit(1)
		return rows[0]
	},

	async findBaseBySlug(workspaceId: string, slug: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(knowledgeBase)
			.where(
				and(eq(knowledgeBase.organizationId, workspaceId), eq(knowledgeBase.slug, slug)),
			)
			.limit(1)
		return rows[0]
	},

	async insertBase(entry: typeof knowledgeBase.$inferInsert, executor: DbExecutor = db) {
		const rows = await executor.insert(knowledgeBase).values(entry).returning()
		return rows[0]
	},

	async updateBase(
		workspaceId: string,
		baseId: string,
		patch: Partial<typeof knowledgeBase.$inferInsert>,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.update(knowledgeBase)
			.set(patch)
			.where(
				and(
					eq(knowledgeBase.organizationId, workspaceId),
					eq(knowledgeBase.id, baseId),
				),
			)
			.returning()
		return rows[0]
	},

	async deleteBase(workspaceId: string, baseId: string, executor: DbExecutor = db) {
		const rows = await executor
			.delete(knowledgeBase)
			.where(
				and(
					eq(knowledgeBase.organizationId, workspaceId),
					eq(knowledgeBase.id, baseId),
				),
			)
			.returning({ id: knowledgeBase.id })
		return rows.length > 0
	},

	/** Recomputed from the tables rather than incremented, so it cannot drift. */
	async refreshBaseCounts(baseId: string, executor: DbExecutor = db) {
		await executor
			.update(knowledgeBase)
			.set({
				documentCount: sql`(select count(*)::int from ${document} where ${document.knowledgeBaseId} = ${baseId})`,
				chunkCount: sql`(select count(*)::int from ${chunk} where ${chunk.knowledgeBaseId} = ${baseId})`,
			})
			.where(eq(knowledgeBase.id, baseId))
	},

	// ── Documents ──────────────────────────────────────────────────────────────

	async listDocuments(
		workspaceId: string,
		baseId: string,
		query: PaginationQuery,
		executor: DbExecutor = db,
	) {
		const where = and(
			eq(document.organizationId, workspaceId),
			eq(document.knowledgeBaseId, baseId),
		)

		const items = await executor
			.select()
			.from(document)
			.where(where)
			.orderBy(desc(document.createdAt))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor.select({ value: count() }).from(document).where(where)

		return { items, total: totals?.value ?? 0 }
	},

	async findDocument(workspaceId: string, documentId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(document)
			.where(
				and(eq(document.organizationId, workspaceId), eq(document.id, documentId)),
			)
			.limit(1)
		return rows[0]
	},

	/**
	 * By id alone, without a workspace. The one caller is the worker, which was
	 * handed the id by a job it enqueued itself — there is no request and no
	 * caller to scope against. Never reachable from a route.
	 */
	async findDocumentById(documentId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(document)
			.where(eq(document.id, documentId))
			.limit(1)
		return rows[0]
	},

	async insertDocument(entry: typeof document.$inferInsert, executor: DbExecutor = db) {
		const rows = await executor.insert(document).values(entry).returning()
		return rows[0]
	},

	async updateDocument(
		documentId: string,
		patch: Partial<typeof document.$inferInsert>,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.update(document)
			.set(patch)
			.where(eq(document.id, documentId))
			.returning()
		return rows[0]
	},

	async deleteDocument(workspaceId: string, documentId: string, executor: DbExecutor = db) {
		const rows = await executor
			.delete(document)
			.where(
				and(eq(document.organizationId, workspaceId), eq(document.id, documentId)),
			)
			.returning({ id: document.id })
		return rows.length > 0
	},

	// ── Chunks ─────────────────────────────────────────────────────────────────

	/** Removes a document's chunks so a re-ingestion replaces rather than appends. */
	async deleteChunksOfDocument(documentId: string, executor: DbExecutor = db) {
		await executor.delete(chunk).where(eq(chunk.documentId, documentId))
	},

	/**
	 * Enough of a document's chunks to decide, on a re-ingestion, which of them
	 * the new task plan already covers. Content is not selected: a document of
	 * several thousand passages would be megabytes of text read only to be
	 * compared on a hash column.
	 */
	async listChunkKeysOfDocument(documentId: string, executor: DbExecutor = db) {
		return executor
			.select({
				id: chunk.id,
				digest: chunk.digest,
				ordinal: chunk.ordinal,
				level: chunk.level,
				tokenCount: chunk.tokenCount,
			})
			.from(chunk)
			.where(eq(chunk.documentId, documentId))
	},

	async deleteChunksByIds(chunkIds: string[], executor: DbExecutor = db) {
		if (chunkIds.length === 0) return
		const BATCH = 500
		for (let offset = 0; offset < chunkIds.length; offset += BATCH) {
			await executor
				.delete(chunk)
				.where(inArray(chunk.id, chunkIds.slice(offset, offset + BATCH)))
		}
	},

	/** Points a summary's members at it, so the tree can be walked from a leaf. */
	async setChunkParent(parentChunkId: string, childIds: string[], executor: DbExecutor = db) {
		if (childIds.length === 0) return
		await executor.update(chunk).set({ parentChunkId }).where(inArray(chunk.id, childIds))
	},

	/** Leaf passages, with the text the summary tree summarises. */
	async listLeafChunksOfDocument(documentId: string, executor: DbExecutor = db) {
		return executor
			.select({ id: chunk.id, content: chunk.content, ordinal: chunk.ordinal })
			.from(chunk)
			.where(and(eq(chunk.documentId, documentId), eq(chunk.level, 0)))
			.orderBy(asc(chunk.ordinal))
	},

	// ── Ingestion tasks ────────────────────────────────────────────────────────

	async listTasks(documentId: string, executor: DbExecutor = db) {
		return executor
			.select()
			.from(ingestionTask)
			.where(eq(ingestionTask.documentId, documentId))
			.orderBy(asc(ingestionTask.fromPage), asc(ingestionTask.createdAt))
	},

	async replaceTasks(
		documentId: string,
		entries: (typeof ingestionTask.$inferInsert)[],
		executor: DbExecutor = db,
	) {
		// One transaction: a plan half-written would leave the document with tasks
		// from two different attempts and no way to tell them apart.
		await executor.transaction(async (tx) => {
			await tx.delete(ingestionTask).where(eq(ingestionTask.documentId, documentId))
			if (entries.length > 0) await tx.insert(ingestionTask).values(entries)
		})
	},

	async updateTask(
		taskId: string,
		patch: Partial<typeof ingestionTask.$inferInsert>,
		executor: DbExecutor = db,
	) {
		await executor.update(ingestionTask).set(patch).where(eq(ingestionTask.id, taskId))
	},

	/**
	 * The cancel flag alone. Read between stages of a long ingestion, so it is a
	 * one-column query rather than a full document row each time.
	 */
	async isCancelRequested(documentId: string, executor: DbExecutor = db) {
		const rows = await executor
			.select({ cancelRequested: document.cancelRequested })
			.from(document)
			.where(eq(document.id, documentId))
			.limit(1)
		return rows[0]?.cancelRequested ?? false
	},

	async insertChunks(entries: NewChunk[], executor: DbExecutor = db) {
		if (entries.length === 0) return
		// Chunked insert: a document of several thousand passages would otherwise
		// build one statement with tens of thousands of bind parameters, and
		// Postgres caps those at 65535.
		const BATCH = 500
		for (let offset = 0; offset < entries.length; offset += BATCH) {
			await executor.insert(chunk).values(entries.slice(offset, offset + BATCH))
		}
	},

	async listChunksOfDocument(
		workspaceId: string,
		documentId: string,
		query: PaginationQuery,
		executor: DbExecutor = db,
	) {
		const where = and(
			eq(chunk.organizationId, workspaceId),
			eq(chunk.documentId, documentId),
		)

		const items = await executor
			.select()
			.from(chunk)
			.where(where)
			.orderBy(asc(chunk.ordinal))
			.limit(query.limit)
			.offset(query.offset)

		const [totals] = await executor.select({ value: count() }).from(chunk).where(where)

		return { items, total: totals?.value ?? 0 }
	},

	/** The chunks behind a set of hits, with the document name a citation needs. */
	async findChunksByIds(
		workspaceId: string,
		chunkIds: string[],
		executor: DbExecutor = db,
	) {
		if (chunkIds.length === 0) return []
		return executor
			.select({
				id: chunk.id,
				content: chunk.content,
				ordinal: chunk.ordinal,
				tokenCount: chunk.tokenCount,
				documentId: chunk.documentId,
				documentName: document.name,
				knowledgeBaseId: chunk.knowledgeBaseId,
				kind: chunk.kind,
				level: chunk.level,
				fromPage: chunk.fromPage,
				toPage: chunk.toPage,
			})
			.from(chunk)
			.innerJoin(document, eq(document.id, chunk.documentId))
			.where(and(eq(chunk.organizationId, workspaceId), inArray(chunk.id, chunkIds)))
	},

	/**
	 * The lexical half of hybrid retrieval.
	 *
	 * `websearch_to_tsquery` rather than `plainto_tsquery`: it tolerates the
	 * punctuation and quoting people actually type into a chat box instead of
	 * raising a syntax error on it. `ts_rank_cd` weights by how close the matched
	 * terms are to each other, which is the closest thing Postgres offers to the
	 * term-proximity scoring RAGFlow builds by hand.
	 */
	async searchChunksByText(
		workspaceId: string,
		baseIds: string[],
		queryText: string,
		limit: number,
		documentIds?: string[],
		executor: DbExecutor = db,
	) {
		if (baseIds.length === 0) return []

		const tsquery = sql`websearch_to_tsquery('simple', ${queryText})`
		// Matches the expression the GIN index is built on, or Postgres cannot use
		// it. The enrichment columns are in both: a keyword a model added exists
		// precisely because the passage does not contain the word people search
		// for, and leaving it out of the query makes generating it pointless.
		const tsvector = sql`to_tsvector('simple', ${chunk.content} || ' ' || coalesce(${chunk.question}, '') || ' ' || array_to_string(${chunk.keywords}, ' ') || ' ' || array_to_string(${chunk.questions}, ' '))`

		// The document filter belongs on *both* halves of hybrid retrieval. It was
		// once only on the dense half, and a question scoped to one file could
		// still be answered — and cited — from another, because the lexical half
		// never saw the restriction.
		const scope = documentIds?.length
			? and(inArray(chunk.knowledgeBaseId, baseIds), inArray(chunk.documentId, documentIds))
			: inArray(chunk.knowledgeBaseId, baseIds)

		return executor
			.select({
				id: chunk.id,
				documentId: chunk.documentId,
				score: sql<number>`ts_rank_cd(${tsvector}, ${tsquery})`,
			})
			.from(chunk)
			.where(and(eq(chunk.organizationId, workspaceId), scope, sql`${tsvector} @@ ${tsquery}`))
			.orderBy(sql`ts_rank_cd(${tsvector}, ${tsquery}) desc`)
			.limit(limit)
	},
}
