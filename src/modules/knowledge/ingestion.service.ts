import { embedTexts, resolveEmbeddingModel } from "../../ai/embed"
import { NotFoundError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import { getObject } from "../../storage/objects"
import { deleteDocumentVectors, upsertChunkVectors } from "../../vector/qdrant"
import { usageService } from "../usage/usage.service"
import { chunkSections } from "./chunker"
import { extractSections } from "./extractor"
import { knowledgeRepository } from "./knowledge.repository"

const log = logger.child({ module: "ingestion" })

/**
 * The document pipeline: bytes → text → chunks → vectors.
 *
 * It runs in the worker, never in a request. Parsing a 200-page PDF and calling
 * an embedding provider four times takes tens of seconds, and an HTTP request
 * that does that is a request that times out behind a proxy and leaves a
 * half-indexed document nobody knows about.
 *
 * Written to be safe to run twice on the same document, because a retried job
 * will. Every stage replaces rather than appends: the chunk rows are deleted
 * before new ones are written, and the vectors are deleted from Qdrant by
 * document filter before new ones are upserted. A second run therefore converges
 * on the same state as the first.
 */
const STAGE_PARSING = "parsing"
const STAGE_CHUNKING = "chunking"
const STAGE_EMBEDDING = "embedding"

export interface IngestOptions {
	/**
	 * Idempotency key for the credit charge. The BullMQ job id, so retries of one
	 * job share it. A retry that re-embeds after a later stage failed therefore
	 * costs Ragenta a second provider call it does not pass on — the alternative,
	 * a fresh reference per attempt, would bill the customer twice for one
	 * document, and that is the worse of the two.
	 */
	reference: string
}

export const ingestionService = {
	async ingestDocument(documentId: string, options: IngestOptions) {
		const row = await knowledgeRepository.findDocumentById(documentId)
		if (!row) throw new NotFoundError("Document")

		const base = await knowledgeRepository.findBase(row.organizationId, row.knowledgeBaseId)
		if (!base) throw new NotFoundError("Knowledge base")

		try {
			// Resolved first: a knowledge base whose embedding model has since been
			// removed should fail before anything is parsed or deleted.
			const target = await resolveEmbeddingModel(
				base.embeddingProvider,
				base.embeddingModel,
			)

			await knowledgeRepository.updateDocument(documentId, {
				status: STAGE_PARSING,
				error: null,
			})
			const bytes = await getObject(row.storageKey)
			const sections = await extractSections(bytes, row.mimeType, row.name)

			if (sections.length === 0) {
				return this.fail(
					documentId,
					"No text could be read from this file. A scanned PDF needs OCR, which Ragenta does not do yet.",
				)
			}

			await knowledgeRepository.updateDocument(documentId, { status: STAGE_CHUNKING })
			const chunks = chunkSections(sections, {
				tokenSize: base.chunkTokenSize,
				overlapPercent: base.chunkOverlapPercent,
			})

			if (chunks.length === 0) {
				return this.fail(documentId, "The file contained no passage long enough to index.")
			}

			// Replace, do not append. Both sides go first so a crash between them
			// leaves orphaned vectors rather than orphaned text — and the vector
			// delete is by filter, so the next run clears them anyway.
			await deleteDocumentVectors(target.dimensions, row.organizationId, documentId)
			await knowledgeRepository.deleteChunksOfDocument(documentId)

			const rows = chunks.map((entry, ordinal) => ({
				id: newId(),
				organizationId: row.organizationId,
				knowledgeBaseId: row.knowledgeBaseId,
				documentId,
				ordinal,
				content: entry.content,
				tokenCount: entry.tokenCount,
			}))
			await knowledgeRepository.insertChunks(rows)

			await knowledgeRepository.updateDocument(documentId, { status: STAGE_EMBEDDING })
			const embedding = await embedTexts(
				target,
				rows.map((entry) => entry.content),
			)

			await upsertChunkVectors(
				target.dimensions,
				rows.map((entry, index) => ({
					chunkId: entry.id,
					vector: embedding.vectors[index] ?? [],
					workspaceId: entry.organizationId,
					knowledgeBaseId: entry.knowledgeBaseId,
					documentId: entry.documentId,
					ordinal: entry.ordinal,
				})),
			)

			// Charged after the vectors are in: a document the customer cannot
			// retrieve from is not a document they should pay to have indexed.
			await usageService.recordAndCharge({
				workspaceId: row.organizationId,
				userId: row.createdBy,
				operation: "embedding",
				provider: target.provider,
				model: target.model,
				embeddingTokens: embedding.embeddingTokens,
				reference: options.reference,
				metadata: {
					documentId,
					knowledgeBaseId: row.knowledgeBaseId,
					chunks: rows.length,
					tokensEstimated: embedding.estimated,
				},
			})

			const tokenCount = rows.reduce((total, entry) => total + entry.tokenCount, 0)
			await knowledgeRepository.updateDocument(documentId, {
				status: "ready",
				error: null,
				chunkCount: rows.length,
				tokenCount,
				indexedAt: new Date(),
			})
			await knowledgeRepository.refreshBaseCounts(row.knowledgeBaseId)

			log.info("ingestion.completed", {
				documentId,
				workspaceId: row.organizationId,
				chunks: rows.length,
				tokens: tokenCount,
			})

			return { documentId, status: "ready" as const, chunks: rows.length }
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "The document could not be indexed."
			log.error("ingestion.failed", error, { documentId })
			return this.fail(documentId, message)
		}
	},

	/**
	 * Records why a document is not indexed, on the document, in words the
	 * uploader can act on. Failures are a normal outcome here — an encrypted PDF,
	 * a provider outage — and hiding them in a log would leave a row stuck at
	 * "embedding" with nothing to explain it.
	 */
	async fail(documentId: string, message: string) {
		await knowledgeRepository.updateDocument(documentId, {
			status: "failed",
			error: message.slice(0, 500),
		})
		return { documentId, status: "failed" as const, error: message }
	},

	/** Drops everything derived from a document, in both stores. */
	async purgeDocument(
		workspaceId: string,
		documentId: string,
		dimensions: number,
	): Promise<void> {
		await deleteDocumentVectors(dimensions, workspaceId, documentId)
		await knowledgeRepository.deleteChunksOfDocument(documentId)
	},
}
