import { Buffer } from "node:buffer"
import { knowledgeBase } from "../../db/schema"

import { resolveEmbeddingModel } from "../../ai/embed"
import { resolveRerankModel } from "../../ai/rerank"
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
import { billingService } from "../billing/billing.service"
import { modelService } from "../model/model.service"
import { visibilityFor } from "../rbac/visibility"
import type { MembershipRow } from "../workspace/workspace.repository"
import { ingestionService } from "./ingestion.service"
import { knowledgeRepository } from "./knowledge.repository"
import { resolveFormat } from "./extractor"
import { PARSER_LIST, assertParserAccepts } from "./parsers"
import {
	DEFAULT_SIMILARITY_THRESHOLD,
	DEFAULT_TOP_K,
	DEFAULT_VECTOR_WEIGHT,
} from "../retrieval/retrieval.service"
import type {
	CreateKnowledgeBaseInput,
	ReindexDocumentInput,
	UpdateKnowledgeBaseInput,
	UploadDocumentInput,
} from "./knowledge.dto"

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
	/** Narrowed to the bases this caller may read, page and total together (ADR-054). */
	async listBases(membership: MembershipRow, query: PaginationQuery) {
		const visible = await visibilityFor(membership, "knowledgeBase", "knowledgeBase.read")
		const { items, total } = await knowledgeRepository.listBases(
			membership.organizationId,
			query,
			visible.unrestricted ? undefined : visible.condition(knowledgeBase.id),
		)
		return page(items, total, query)
	},

	async getBase(workspaceId: string, baseId: string) {
		const base = await knowledgeRepository.findBase(workspaceId, baseId)
		if (!base) throw new NotFoundError("Knowledge base")
		return base
	},

	/**
	 * Proves every knowledge base belongs to this workspace, and that they can be
	 * searched together.
	 *
	 * The ids came from a client and nothing else would check them. The embedding
	 * comparison is the second half: two bases embedded with different models
	 * produce vectors that are not comparable, so searching them together would
	 * not degrade the ranking, it would invent one. Refusing at the point the set
	 * is chosen is the only place a user can act on it.
	 *
	 * It lives here rather than in the caller because both a conversation and an
	 * agent choose a set of bases, and the rule is the same for either.
	 */
	async assertBasesSearchableTogether(workspaceId: string, baseIds: string[]) {
		const unique = [...new Set(baseIds)]
		if (unique.length === 0) return

		const bases = await Promise.all(unique.map((baseId) => this.getBase(workspaceId, baseId)))

		const primary = bases[0]
		if (!primary) return

		const mismatched = bases.find(
			(base) =>
				base.embeddingProvider !== primary.embeddingProvider ||
				base.embeddingModel !== primary.embeddingModel,
		)
		if (mismatched) {
			throw new ValidationError(
				`"${mismatched.name}" and "${primary.name}" use different embedding models, so they cannot be searched together. Search them separately, or rebuild one of them on the other's model.`,
			)
		}
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

		await billingService.assertWithinPlanLimit(workspaceId, "knowledgeBaseLimit", () =>
			knowledgeRepository.countBases(workspaceId),
		)

		const selection =
			input.embedding ?? (await modelService.getSettings(workspaceId)).embedding
		await modelService.assertSelectable(workspaceId, selection, "embedding")
		const target = await resolveEmbeddingModel(selection.provider, selection.model)

		const slug = input.slug ?? slugify(input.name)
		if (await knowledgeRepository.findBaseBySlug(workspaceId, slug)) {
			throw new ConflictError(`A knowledge base with the slug "${slug}" already exists.`)
		}

		// Refused before the row exists: a base whose reranker cannot be called
		// would fail on every query, with nothing on screen to say why.
		if (input.rerank) {
			await resolveRerankModel(input.rerank.provider, input.rerank.model)
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
			parserId: input.parserId,
			parserConfig: input.parserConfig,
			topK: input.topK ?? DEFAULT_TOP_K,
			similarityThreshold: (input.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD).toFixed(3),
			vectorWeight: (input.vectorWeight ?? DEFAULT_VECTOR_WEIGHT).toFixed(3),
			rerankProvider: input.rerank?.provider ?? null,
			rerankModel: input.rerank?.model ?? null,
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
		if (input.rerank) {
			await resolveRerankModel(input.rerank.provider, input.rerank.model)
		}

		const updated = await knowledgeRepository.updateBase(workspaceId, baseId, {
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.description !== undefined ? { description: input.description } : {}),
			...(input.chunkTokenSize !== undefined
				? { chunkTokenSize: input.chunkTokenSize }
				: {}),
			...(input.chunkOverlapPercent !== undefined
				? { chunkOverlapPercent: input.chunkOverlapPercent }
				: {}),
			...(input.parserId !== undefined ? { parserId: input.parserId } : {}),
			...(input.parserConfig !== undefined ? { parserConfig: input.parserConfig } : {}),
			...(input.topK !== undefined ? { topK: input.topK } : {}),
			...(input.similarityThreshold !== undefined
				? { similarityThreshold: input.similarityThreshold.toFixed(3) }
				: {}),
			...(input.vectorWeight !== undefined
				? { vectorWeight: input.vectorWeight.toFixed(3) }
				: {}),
			...(input.rerank !== undefined
				? {
						rerankProvider: input.rerank?.provider ?? null,
						rerankModel: input.rerank?.model ?? null,
					}
				: {}),
		})
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
		options: UploadDocumentInput,
		actorId: string,
	) {
		assertInfrastructure()
		const base = await this.getBase(workspaceId, baseId)

		if (file.bytes.length === 0) throw new ValidationError("The file is empty.")
		if (file.bytes.length > MAX_UPLOAD_BYTES) {
			throw new ValidationError(
				`The file is larger than the ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`,
			)
		}

		// Refused before anything is stored: an unreadable format would otherwise
		// occupy the bucket and fail in the worker, where nobody is watching. The
		// second check is the strategy's own — the Table method cannot read a PDF,
		// and finding that out at upload is the only time the user can fix it.
		const format = resolveFormat(file.mimeType, file.name)
		assertParserAccepts(options.parserId ?? base.parserId, format, file.name)

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
			parserId: options.parserId ?? null,
			parserConfig: options.parserConfig ?? null,
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
	async reindexDocument(
		workspaceId: string,
		documentId: string,
		input: ReindexDocumentInput,
		actorId: string,
	) {
		const row = await this.getDocument(workspaceId, documentId)
		const base = await this.getBase(workspaceId, row.knowledgeBaseId)
		assertInfrastructure()

		const parserId =
			input.parserId === undefined ? (row.parserId ?? base.parserId) : (input.parserId ?? base.parserId)
		assertParserAccepts(parserId, resolveFormat(row.mimeType, row.name), row.name)

		const attempt = row.attempt + 1

		await knowledgeRepository.updateDocument(documentId, {
			status: "pending",
			error: null,
			progress: "0",
			progressMessage: "Queued for re-indexing",
			// Any earlier cancel is spent: this is a new run, and starting it with
			// the flag still set would cancel it before it did anything.
			cancelRequested: false,
			attempt,
			...(input.parserId !== undefined ? { parserId: input.parserId } : {}),
			...(input.parserConfig !== undefined ? { parserConfig: input.parserConfig } : {}),
		})

		// The attempt number is the job id, so a re-index is always a new job while
		// a duplicate click on the same attempt is not. The pipeline's digest
		// comparison is what then decides how much of the work actually repeats.
		await enqueueDocumentIngestion({ documentId, workspaceId }, attempt)

		await auditService.record({
			action: "knowledge.document.reindexed",
			actorId,
			organizationId: workspaceId,
			targetType: "document",
			targetId: documentId,
			metadata: { name: row.name, attempt, parserId },
		})

		return { ...row, status: "pending", attempt }
	},

	/**
	 * Asks the worker to stop between stages.
	 *
	 * A flag rather than a job removal: the job may be mid-way through a provider
	 * call that has already been paid for, and BullMQ cannot interrupt one. The
	 * passages already written stay — they are real, and discarding them would
	 * make cancelling strictly worse than waiting.
	 */
	async cancelDocument(workspaceId: string, documentId: string, actorId: string) {
		const row = await this.getDocument(workspaceId, documentId)
		if (row.status === "ready" || row.status === "failed" || row.status === "cancelled") {
			throw new ValidationError(`This document is not being indexed — it is ${row.status}.`)
		}

		await knowledgeRepository.updateDocument(documentId, {
			cancelRequested: true,
			progressMessage: "Stopping after the current step",
		})

		await auditService.record({
			action: "knowledge.document.cancelled",
			actorId,
			organizationId: workspaceId,
			targetType: "document",
			targetId: documentId,
			metadata: { name: row.name, status: row.status },
		})

		return { id: documentId, cancelRequested: true }
	},

	/** The ingestion plan and what each part of it did. Drives the progress detail. */
	async listTasks(workspaceId: string, documentId: string) {
		await this.getDocument(workspaceId, documentId)
		return { items: await knowledgeRepository.listTasks(documentId) }
	},

	/** The chunking strategies this deployment offers, and what each one reads. */
	listParsers() {
		return {
			items: PARSER_LIST.map((parser) => ({
				id: parser.id,
				name: parser.name,
				description: parser.description,
				formats: parser.formats,
				available: parser.parse !== undefined,
				unavailable: parser.unavailable ?? null,
			})),
		}
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
