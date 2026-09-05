import { Buffer } from "node:buffer"

import { resolveEmbeddingModel } from "../../ai/embed"
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import type { PaginationQuery } from "../../shared/pagination"
import { page } from "../../shared/pagination"
import {
	documentKey,
	isStorageConfigured,
	presignedDownloadUrl,
	putObject,
	removeObject,
} from "../../storage/objects"
import { StorageUnavailableError } from "../../storage/objects"
import { deleteKnowledgeBaseVectors, isVectorStoreConfigured } from "../../vector/qdrant"
import { VectorStoreUnavailableError } from "../../vector/qdrant"
import { enqueueDocumentIngestion } from "../../jobs/ingestion.jobs"
import { auditService } from "../audit/audit.service"
import { modelService } from "../model/model.service"
import { ingestionService } from "./ingestion.service"
import { knowledgeRepository } from "./knowledge.repository"
import { resolveFormat } from "./extractor"
import type { CreateKnowledgeBaseInput, UpdateKnowledgeBaseInput } from "./knowledge.dto"

const log = logger.child({ module: "knowledge" })

/**
 * Uploads are capped well below what the pipeline could technically handle. The
 * limit is memory, not storage: parsing holds the whole file and its extracted
 * text at once, and the worker runs two of those concurrently.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.normalize("NFD")
			// Vietnamese đ/Đ is not a diacritic combination, so NFD leaves it alone.
			.replace(/đ/g, "d")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || "knowledge-base"
	)
}

/**
 * Both stores have to be there before a knowledge base means anything. Checked
 * up front so the failure is "this deployment has no vector store" rather than a
 * document that uploads fine and then sits at `pending` forever.
 */
function assertInfrastructure(): void {
	if (!isStorageConfigured()) throw new StorageUnavailableError()
	if (!isVectorStoreConfigured()) throw new VectorStoreUnavailableError()
}

export const knowledgeService = {
	async listBases(workspaceId: string, query: PaginationQuery) {
		const { items, total } = await knowledgeRepository.listBases(workspaceId, query)
		return page(items, total, query)
	},

	async getBase(workspaceId: string, baseId: string) {
		const base = await knowledgeRepository.findBase(workspaceId, baseId)
		if (!base) throw new NotFoundError("Knowledge base")
		return base
	},

	/**
	 * The embedding model is resolved once, here, and written onto the row. From
	 * then on the knowledge base is pinned to it — changing the workspace default
	 * later moves new knowledge bases, never this one's existing vectors.
	 */
	async createBase(
		workspaceId: string,
		input: CreateKnowledgeBaseInput,
		actorId: string,
	) {
		assertInfrastructure()

		const selection =
			input.embedding ?? (await modelService.getSettings(workspaceId)).embedding
		await modelService.assertSelectable(workspaceId, selection, "embedding")
		const target = await resolveEmbeddingModel(selection.provider, selection.model)

		const slug = input.slug ?? slugify(input.name)
		if (await knowledgeRepository.findBaseBySlug(workspaceId, slug)) {
			throw new ConflictError(`A knowledge base with the slug "${slug}" already exists.`)
		}

		const base = await knowledgeRepository.insertBase({
			id: newId(),
			organizationId: workspaceId,
			name: input.name,
			slug,
			description: input.description,
			embeddingProvider: target.provider,
			embeddingModel: target.model,
			embeddingDimensions: target.dimensions,
			chunkTokenSize: input.chunkTokenSize,
			chunkOverlapPercent: input.chunkOverlapPercent,
			createdBy: actorId,
		})

		await auditService.record({
			action: "knowledge.base.created",
			actorId,
			organizationId: workspaceId,
			targetType: "knowledge_base",
			targetId: base?.id ?? slug,
			metadata: { name: input.name, slug, embedding: target },
		})

		return base
	},

	async updateBase(
		workspaceId: string,
		baseId: string,
		input: UpdateKnowledgeBaseInput,
		actorId: string,
	) {
		const updated = await knowledgeRepository.updateBase(workspaceId, baseId, input)
		if (!updated) throw new NotFoundError("Knowledge base")

		await auditService.record({
			action: "knowledge.base.updated",
			actorId,
			organizationId: workspaceId,
			targetType: "knowledge_base",
			targetId: baseId,
			metadata: { ...input },
		})

		return updated
	},

	/**
	 * Deletes the base and everything derived from it, in all three stores.
	 *
	 * Order matters. Vectors first, because they are the only thing here with no
	 * foreign key back to a row — once the base is gone nothing knows which
	 * collection they are in. Objects next. Postgres last, where the cascade does
	 * the rest.
	 */
	async deleteBase(workspaceId: string, baseId: string, actorId: string) {
		const base = await this.getBase(workspaceId, baseId)

		await deleteKnowledgeBaseVectors(base.embeddingDimensions, workspaceId, baseId)

		const { items } = await knowledgeRepository.listDocuments(workspaceId, baseId, {
			limit: 1000,
			offset: 0,
		})
		for (const item of items) {
			await removeObject(item.storageKey).catch((error: unknown) => {
				// An object that is already gone is the desired end state; one that
				// will not delete is a leak worth knowing about but not worth failing
				// the whole deletion over.
				log.warn("storage.delete_failed", { key: item.storageKey, error: String(error) })
			})
		}

		await knowledgeRepository.deleteBase(workspaceId, baseId)

		await auditService.record({
			action: "knowledge.base.deleted",
			actorId,
			organizationId: workspaceId,
			targetType: "knowledge_base",
			targetId: baseId,
			metadata: { name: base.name, documents: items.length },
		})

		return { id: baseId }
	},

	// ── Documents ──────────────────────────────────────────────────────────────

	async listDocuments(workspaceId: string, baseId: string, query: PaginationQuery) {
		await this.getBase(workspaceId, baseId)
		const { items, total } = await knowledgeRepository.listDocuments(
			workspaceId,
			baseId,
			query,
		)
		return page(items, total, query)
	},

	async getDocument(workspaceId: string, documentId: string) {
		const row = await knowledgeRepository.findDocument(workspaceId, documentId)
		if (!row) throw new NotFoundError("Document")
		return row
	},

	/**
	 * Stores the bytes and queues the work. The response is the `pending` row —
	 * the upload is finished, the indexing has not started, and telling the
	 * uploader otherwise would be a lie they find out about a minute later.
	 */
	async uploadDocument(
		workspaceId: string,
		baseId: string,
		file: { name: string; mimeType: string; bytes: Buffer },
		actorId: string,
	) {
		assertInfrastructure()
		await this.getBase(workspaceId, baseId)

		if (file.bytes.length === 0) throw new ValidationError("The file is empty.")
		if (file.bytes.length > MAX_UPLOAD_BYTES) {
			throw new ValidationError(
				`The file is larger than the ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`,
			)
		}

		// Refused before anything is stored: an unreadable format would otherwise
		// occupy the bucket and fail in the worker, where nobody is watching.
		resolveFormat(file.mimeType, file.name)

		const id = newId()
		const key = documentKey(workspaceId, id)
		await putObject(key, file.bytes, file.mimeType)

		const row = await knowledgeRepository.insertDocument({
			id,
			organizationId: workspaceId,
			knowledgeBaseId: baseId,
			name: file.name.slice(0, 300),
			storageKey: key,
			mimeType: file.mimeType,
			sizeBytes: file.bytes.length,
			status: "pending",
			createdBy: actorId,
		})

		await enqueueDocumentIngestion({ documentId: id, workspaceId }, 1)
		await knowledgeRepository.refreshBaseCounts(baseId)

		await auditService.record({
			action: "knowledge.document.uploaded",
			actorId,
			organizationId: workspaceId,
			targetType: "document",
			targetId: id,
			metadata: { name: file.name, bytes: file.bytes.length, knowledgeBaseId: baseId },
		})

		return row
	},

	/**
	 * Queues the document again — after a provider outage, or once a knowledge
	 * base's settings have been changed deliberately. A fresh attempt number
	 * makes it a new job, and therefore a new credit charge, because it is a new
	 * set of embeddings.
	 */
	async reindexDocument(workspaceId: string, documentId: string, actorId: string) {
		const row = await this.getDocument(workspaceId, documentId)
		assertInfrastructure()

		await knowledgeRepository.updateDocument(documentId, {
			status: "pending",
			error: null,
		})
		await enqueueDocumentIngestion({ documentId, workspaceId }, Date.now())

		await auditService.record({
			action: "knowledge.document.reindexed",
			actorId,
			organizationId: workspaceId,
			targetType: "document",
			targetId: documentId,
			metadata: { name: row.name },
		})

		return { ...row, status: "pending" }
	},

	async deleteDocument(workspaceId: string, documentId: string, actorId: string) {
		const row = await this.getDocument(workspaceId, documentId)
		const base = await this.getBase(workspaceId, row.knowledgeBaseId)

		await ingestionService.purgeDocument(workspaceId, documentId, base.embeddingDimensions)
		await removeObject(row.storageKey).catch((error: unknown) => {
			log.warn("storage.delete_failed", { key: row.storageKey, error: String(error) })
		})
		await knowledgeRepository.deleteDocument(workspaceId, documentId)
		await knowledgeRepository.refreshBaseCounts(row.knowledgeBaseId)

		await auditService.record({
			action: "knowledge.document.deleted",
			actorId,
			organizationId: workspaceId,
			targetType: "document",
			targetId: documentId,
			metadata: { name: row.name, knowledgeBaseId: row.knowledgeBaseId },
		})

		return { id: documentId }
	},

	async listChunks(workspaceId: string, documentId: string, query: PaginationQuery) {
		await this.getDocument(workspaceId, documentId)
		const { items, total } = await knowledgeRepository.listChunksOfDocument(
			workspaceId,
			documentId,
			query,
		)
		return page(items, total, query)
	},

	/** A short-lived direct URL. The API never streams the bytes itself. */
	async downloadUrl(workspaceId: string, documentId: string) {
		const row = await this.getDocument(workspaceId, documentId)
		return { url: await presignedDownloadUrl(row.storageKey), name: row.name }
	},
}
