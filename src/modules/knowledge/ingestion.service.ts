import { createHash } from "node:crypto"

import { requireCredential } from "../../ai/catalogue"
import { providerClient } from "../../ai/clients"
import { embedTexts, resolveEmbeddingModel } from "../../ai/embed"
import type { EmbeddingModel } from "../../ai/embed"
import { NotFoundError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import { getObject } from "../../storage/objects"
import {
	deleteChunkVectors,
	deleteDocumentVectors,
	fetchChunkVectors,
	upsertChunkVectors,
} from "../../vector/qdrant"
import { modelService } from "../model/model.service"
import { usageService } from "../usage/usage.service"
import { countPdfPages, resolveFormat } from "./extractor"
import { embeddingText, enrichChunks, enrichmentText } from "./enrichment"
import type { NewChunk } from "./knowledge.repository"
import { knowledgeRepository } from "./knowledge.repository"
import { resolveParserConfig, runParser } from "./parsers"
import type { ParsedChunk, ResolvedParserConfig } from "./parsers"
import { buildRaptorTree, summaryPrompt } from "./raptor"
import { webhookService } from "../webhook/webhook.service"

const log = logger.child({ module: "ingestion" })

/**
 * The document pipeline: bytes → tasks → chunks → enrichment → vectors → summaries.
 *
 * It runs in the worker, never in a request. Parsing a 200-page PDF and calling
 * an embedding provider four times takes tens of seconds, and an HTTP request
 * that does that is a request that times out behind a proxy and leaves a
 * half-indexed document nobody knows about.
 *
 * **Work is split into tasks by page range and each task is identified by a
 * digest** — RAGFlow's `queue_tasks`. The digest hashes the parser, its config,
 * the document and the range, so equal digests mean equal output. A re-index
 * after changing one setting therefore reuses every range that setting did not
 * affect, rather than re-parsing, re-embedding and re-billing the whole file.
 * The same comparison makes a retried BullMQ job resume where it stopped instead
 * of starting again.
 *
 * Written to be safe to run twice, because a retried job will: every stage
 * replaces rather than appends, and the replacement is scoped to the digests
 * that actually changed.
 */

/**
 * Pages per task. RAGFlow uses twelve because DeepDoc renders and runs a layout
 * model over each page; extraction here is text-only and far cheaper, so the
 * ranges are wider and there are fewer of them.
 *
 * The cost of splitting is that each task re-reads the file to reach its own
 * pages — the parser takes bytes, not a pre-extracted section list. That is the
 * same trade RAGFlow makes, and it buys bounded jobs and per-range reuse, which
 * matter more than one extra pass over a PDF that is already in memory.
 */
const PAGES_PER_TASK = 100

/**
 * Ordinal space reserved per task, so a reused range keeps the ordinals it
 * already has while a re-run range is rewritten inside its own block. Without
 * it, one range producing a different number of chunks would renumber every
 * chunk after it and break the unique `(document_id, ordinal)` index.
 */
const ORDINAL_STRIDE = 100_000

/** Summaries live above every parse task's block, ordered by level. */
const SUMMARY_ORDINAL_BASE = 1_000_000_000

const STATUS = {
	parsing: "parsing",
	chunking: "chunking",
	embedding: "embedding",
	enriching: "enriching",
	summarising: "summarising",
	ready: "ready",
	failed: "failed",
	cancelled: "cancelled",
} as const

export interface IngestOptions {
	/**
	 * Idempotency key prefix for the credit charges. The BullMQ job id, so
	 * retries of one job share it; the per-charge suffix is a task digest, which
	 * is stable across retries too. A range that was already embedded and paid
	 * for is therefore never billed twice, whether the second run is a retry or
	 * a deliberate re-index that did not change that range.
	 */
	reference: string
}

interface PlannedTask {
	id: string
	fromPage: number | null
	toPage: number | null
	digest: string
	ordinalBase: number
	/** True when a previous run produced this exact output and its chunks are still there. */
	reusable: boolean
}

function digestOf(parts: unknown): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}

/**
 * Intersects a task's page range with the range the knowledge base asked for, so
 * a parser sees one list rather than a range and a filter it has to combine.
 */
function pagesForTask(
	configured: ResolvedParserConfig["pages"],
	from: number | null,
	to: number | null,
): ResolvedParserConfig["pages"] {
	if (from === null || to === null) return configured
	if (!configured || configured.length === 0) return [[from, to]]

	return configured.flatMap<[number, number]>(([start, end]) => {
		const low = Math.max(start, from)
		const high = Math.min(end, to)
		return low <= high ? [[low, high]] : []
	})
}

export const ingestionService = {
	async ingestDocument(documentId: string, options: IngestOptions) {
		const row = await knowledgeRepository.findDocumentById(documentId)
		if (!row) throw new NotFoundError("Document")

		const base = await knowledgeRepository.findBase(row.organizationId, row.knowledgeBaseId)
		if (!base) throw new NotFoundError("Knowledge base")

		const startedAt = Date.now()

		try {
			// Resolved first: a knowledge base whose embedding model has since been
			// removed should fail before anything is parsed or deleted.
			const target = await resolveEmbeddingModel(
				base.embeddingProvider,
				base.embeddingModel,
			)

			const parserId = row.parserId ?? base.parserId
			const config = resolveParserConfig(base, row.parserConfig)
			const format = resolveFormat(row.mimeType, row.name)

			await this.progress(documentId, 0, "Reading the file", STATUS.parsing, {
				processBeganAt: new Date(),
				error: null,
			})

			const bytes = await getObject(row.storageKey)
			const pageCount = format === "pdf" ? await countPdfPages(bytes) : null
			if (pageCount !== null) {
				await knowledgeRepository.updateDocument(documentId, { pageCount })
			}

			const plan = await this.planTasks({
				documentId,
				parserId,
				config,
				pageCount,
				storageKey: row.storageKey,
				sizeBytes: row.sizeBytes,
			})

			await this.pruneReplacedChunks(row.organizationId, documentId, plan, target.dimensions)
			await this.writePlan(row, plan)

			const pending = plan.filter((task) => !task.reusable)
			const totalSteps = pending.length + (config.raptor.enabled ? 1 : 0) || 1
			let completedSteps = 0
			let produced = 0

			const enrichmentModel =
				config.autoKeywords > 0 || config.autoQuestions > 0
					? await modelService.resolveChatModel(row.organizationId)
					: null

			for (const task of pending) {
				if (await this.stopRequested(documentId)) return this.cancel(documentId, startedAt)

				await knowledgeRepository.updateTask(task.id, {
					status: "running",
					startedAt: new Date(),
				})

				const written = await this.runTask({
					row,
					task,
					parserId,
					config,
					target,
					bytes,
					enrichmentModel,
					reference: options.reference,
				})

				produced += written
				completedSteps += 1
				await this.progress(
					documentId,
					completedSteps / totalSteps,
					`Indexed ${completedSteps} of ${totalSteps} parts`,
					STATUS.embedding,
				)
			}

			if (config.raptor.enabled) {
				if (await this.stopRequested(documentId)) return this.cancel(documentId, startedAt)
				await this.progress(
					documentId,
					completedSteps / totalSteps,
					"Building the summary tree",
					STATUS.summarising,
				)
				await this.buildSummaries({
					row,
					config,
					target,
					reference: options.reference,
					rebuild: pending.length > 0,
				})
			}

			const keys = await knowledgeRepository.listChunkKeysOfDocument(documentId)
			if (keys.length === 0) {
				return this.fail(
					documentId,
					"No text could be read from this file. A scanned PDF needs OCR, which Ragenta does not do yet.",
					startedAt,
				)
			}

			await knowledgeRepository.updateDocument(documentId, {
				status: STATUS.ready,
				error: null,
				progress: "1",
				progressMessage: `${keys.length} passages indexed`,
				chunkCount: keys.length,
				tokenCount: keys.reduce((total, entry) => total + entry.tokenCount, 0),
				indexedAt: new Date(),
				processDurationMs: Date.now() - startedAt,
			})
			await knowledgeRepository.refreshBaseCounts(row.knowledgeBaseId)

			log.info("ingestion.completed", {
				documentId,
				workspaceId: row.organizationId,
				parserId,
				tasks: plan.length,
				reused: plan.length - pending.length,
				chunks: keys.length,
				written: produced,
			})

			await webhookService.emit(row.organizationId, "document.ingested", {
				documentId,
				knowledgeBaseId: row.knowledgeBaseId,
				name: row.name,
				chunks: keys.length,
			})

			return { documentId, status: STATUS.ready, chunks: keys.length }
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "The document could not be indexed."
			log.error("ingestion.failed", error, { documentId })
			return this.fail(documentId, message, startedAt)
		}
	},

	/**
	 * The task plan, and which of its ranges a previous run already produced.
	 *
	 * A range is reusable only when a previous task carried the same digest *and*
	 * chunks with that digest are still in the table. Trusting the task row alone
	 * would keep a "done" marker for chunks a failed delete had already removed.
	 */
	async planTasks(input: {
		documentId: string
		parserId: string
		config: ResolvedParserConfig
		pageCount: number | null
		storageKey: string
		sizeBytes: number
	}): Promise<PlannedTask[]> {
		const ranges: Array<[number | null, number | null]> =
			input.pageCount !== null && input.pageCount > PAGES_PER_TASK
				? Array.from(
						{ length: Math.ceil(input.pageCount / PAGES_PER_TASK) },
						(_, index): [number, number] => [
							index * PAGES_PER_TASK + 1,
							Math.min((index + 1) * PAGES_PER_TASK, input.pageCount ?? 0),
						],
					)
				: [[null, null]]

		const [previous, chunks] = await Promise.all([
			knowledgeRepository.listTasks(input.documentId),
			knowledgeRepository.listChunkKeysOfDocument(input.documentId),
		])

		const settled = new Set(
			previous
				.filter((task) => task.status === "done" || task.status === "reused")
				.map((task) => task.digest),
		)
		const withChunks = new Set(
			chunks.flatMap((entry) => (entry.digest ? [entry.digest] : [])),
		)

		return ranges.map(([fromPage, toPage], index) => {
			const digest = digestOf({
				documentId: input.documentId,
				storageKey: input.storageKey,
				sizeBytes: input.sizeBytes,
				parserId: input.parserId,
				config: input.config,
				fromPage,
				toPage,
			})

			return {
				id: newId(),
				fromPage,
				toPage,
				digest,
				ordinalBase: index * ORDINAL_STRIDE,
				reusable: settled.has(digest) && withChunks.has(digest),
			}
		})
	},

	/**
	 * Removes everything the new plan does not reuse, from both stores.
	 *
	 * Chunks with no digest predate this design and are always replaced; summary
	 * chunks go whenever any parse range is being re-run, because a summary of
	 * passages that changed is a summary of something that no longer exists.
	 */
	async pruneReplacedChunks(
		workspaceId: string,
		documentId: string,
		plan: PlannedTask[],
		dimensions: number,
	): Promise<void> {
		const keep = new Set(plan.filter((task) => task.reusable).map((task) => task.digest))
		const rebuildingSummaries = plan.some((task) => !task.reusable)

		const chunks = await knowledgeRepository.listChunkKeysOfDocument(documentId)
		const doomed = chunks
			.filter((entry) =>
				entry.level > 0 ? rebuildingSummaries : !entry.digest || !keep.has(entry.digest),
			)
			.map((entry) => entry.id)

		if (doomed.length === 0) return

		// Nothing is being kept: the whole-document delete is one filtered call
		// rather than thousands of ids.
		if (doomed.length === chunks.length) {
			await deleteDocumentVectors(dimensions, workspaceId, documentId)
			await knowledgeRepository.deleteChunksOfDocument(documentId)
			return
		}

		// Vectors first: an orphaned vector is retrievable and would be cited with
		// text that no longer exists, where an orphaned row is merely unreachable.
		await deleteChunkVectors(dimensions, workspaceId, doomed)
		await knowledgeRepository.deleteChunksByIds(doomed)
	},

	async writePlan(
		row: { id: string; organizationId: string; knowledgeBaseId: string; attempt: number },
		plan: PlannedTask[],
	): Promise<void> {
		await knowledgeRepository.replaceTasks(
			row.id,
			plan.map((task) => ({
				id: task.id,
				organizationId: row.organizationId,
				knowledgeBaseId: row.knowledgeBaseId,
				documentId: row.id,
				taskType: "parse" as const,
				fromPage: task.fromPage,
				toPage: task.toPage,
				digest: task.digest,
				status: task.reusable ? "reused" : "pending",
				attempt: row.attempt,
				progressMessage: task.reusable ? "Unchanged since the last run" : null,
				finishedAt: task.reusable ? new Date() : null,
			})),
		)
	},

	/** Parse → enrich → store → embed, for one page range. Returns chunks written. */
	async runTask(input: {
		row: { id: string; organizationId: string; knowledgeBaseId: string; name: string; mimeType: string }
		task: PlannedTask
		parserId: string
		config: ResolvedParserConfig
		target: EmbeddingModel
		bytes: Buffer
		enrichmentModel: { provider: string; model: string } | null
		reference: string
	}): Promise<number> {
		const { row, task, config, target } = input

		let parsed: ParsedChunk[]
		try {
			parsed = await runParser(input.parserId, {
				bytes: input.bytes,
				mimeType: row.mimeType,
				filename: row.name,
				format: resolveFormat(row.mimeType, row.name),
				config: {
					...config,
					pages: pagesForTask(config.pages, task.fromPage, task.toPage),
				},
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : "The range could not be parsed."
			await knowledgeRepository.updateTask(task.id, {
				status: "failed",
				error: message.slice(0, 500),
				finishedAt: new Date(),
			})
			throw error
		}

		if (parsed.length === 0) {
			await knowledgeRepository.updateTask(task.id, {
				status: "done",
				progress: "1",
				progressMessage: "No indexable text in this range",
				chunkCount: 0,
				finishedAt: new Date(),
			})
			return 0
		}

		let keywords: string[][] = parsed.map(() => [])
		let questions: string[][] = parsed.map(() => [])

		if (input.enrichmentModel) {
			await this.progress(row.id, null, "Generating keywords and questions", STATUS.enriching)
			const enrichment = await enrichChunks(
				input.enrichmentModel,
				parsed.map((entry) => entry.content),
				{ keywords: config.autoKeywords, questions: config.autoQuestions },
			)
			keywords = enrichment.keywords
			questions = enrichment.questions

			if (enrichment.inputTokens + enrichment.outputTokens > 0) {
				await usageService.recordAndCharge({
					workspaceId: row.organizationId,
					operation: "ingestion",
					provider: input.enrichmentModel.provider,
					model: input.enrichmentModel.model,
					inputTokens: enrichment.inputTokens,
					outputTokens: enrichment.outputTokens,
					reference: `${input.reference}:enrich:${task.digest.slice(0, 16)}`,
					metadata: { documentId: row.id, chunks: parsed.length },
				})
			}
		}

		await this.progress(row.id, null, "Storing passages", STATUS.chunking)

		const rows: NewChunk[] = parsed.map((entry, index) => ({
			id: newId(),
			organizationId: row.organizationId,
			knowledgeBaseId: row.knowledgeBaseId,
			documentId: row.id,
			ordinal: task.ordinalBase + index,
			content: entry.content,
			tokenCount: entry.tokenCount,
			kind: entry.kind,
			question: entry.question,
			keywords: keywords[index] ?? [],
			questions: questions[index] ?? [],
			enrichmentText: enrichmentText({
				question: entry.question,
				keywords: keywords[index] ?? [],
				questions: questions[index] ?? [],
			}),
			fromPage: entry.fromPage,
			toPage: entry.toPage,
			digest: task.digest,
		}))

		await knowledgeRepository.insertChunks(rows)

		await this.progress(row.id, null, "Generating embeddings", STATUS.embedding)
		const embedding = await embedTexts(
			target,
			rows.map((entry) =>
				embeddingText({
					content: entry.content,
					question: entry.question,
					keywords: entry.keywords,
					questions: entry.questions,
				}),
			),
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

		// Charged after the vectors are in: a range the customer cannot retrieve
		// from is not a range they should pay to have indexed.
		await usageService.recordAndCharge({
			workspaceId: row.organizationId,
			operation: "embedding",
			provider: target.provider,
			model: target.model,
			embeddingTokens: embedding.embeddingTokens,
			reference: `${input.reference}:embed:${task.digest.slice(0, 16)}`,
			metadata: {
				documentId: row.id,
				knowledgeBaseId: row.knowledgeBaseId,
				chunks: rows.length,
				tokensEstimated: embedding.estimated,
			},
		})

		await knowledgeRepository.updateTask(task.id, {
			status: "done",
			progress: "1",
			progressMessage: `${rows.length} passages`,
			chunkCount: rows.length,
			finishedAt: new Date(),
		})

		return rows.length
	},

	/**
	 * The RAPTOR pass: cluster the document's passages, summarise each cluster,
	 * index the summaries as chunks one level up, repeat.
	 *
	 * It runs over the whole document rather than per range, because a cluster
	 * that stopped at a page boundary would summarise half a topic — which is why
	 * it is a task of its own rather than a stage inside `runTask`.
	 */
	async buildSummaries(input: {
		row: { id: string; organizationId: string; knowledgeBaseId: string }
		config: ResolvedParserConfig
		target: EmbeddingModel
		reference: string
		rebuild: boolean
	}): Promise<void> {
		const { row, config, target } = input

		// Nothing was re-parsed, so `pruneReplacedChunks` kept the existing
		// summaries — and building them again would insert a second copy of every
		// node. This is the guard that makes a no-op re-index a no-op.
		if (!input.rebuild) {
			const existing = await knowledgeRepository.listChunkKeysOfDocument(row.id)
			if (existing.some((entry) => entry.level > 0)) return
		}

		const leafRows = await knowledgeRepository.listLeafChunksOfDocument(row.id)
		if (leafRows.length < 2) return

		const vectors = await fetchChunkVectors(
			target.dimensions,
			row.organizationId,
			leafRows.map((entry) => entry.id),
		)
		const leaves = leafRows.flatMap((entry) => {
			const vector = vectors.get(entry.id)
			return vector ? [{ id: entry.id, content: entry.content, vector }] : []
		})

		const chatModel = await modelService.resolveChatModel(row.organizationId)
		const chat = providerClient(chatModel.provider)?.chat
		if (!chat) {
			log.warn("raptor.no_chat_adapter", { provider: chatModel.provider })
			return
		}
		const credential = await requireCredential(chatModel.provider)

		let inputTokens = 0
		let outputTokens = 0

		const outcome = await buildRaptorTree(leaves, config.raptor, {
			nextId: newId,
			shouldStop: () => this.stopRequested(row.id),
			async summarise(passages) {
				const result = await chat(credential, {
					model: chatModel.model,
					messages: [{ role: "user", content: summaryPrompt(passages) }],
					temperature: 0,
					maxTokens: 800,
				})
				inputTokens += result.usage.inputTokens
				outputTokens += result.usage.outputTokens
				return result.text
			},
			async embed(texts) {
				const embedded = await embedTexts(target, texts)
				return embedded.vectors
			},
		})

		if (outcome.note) {
			await knowledgeRepository.updateDocument(row.id, { progressMessage: outcome.note })
			log.info("raptor.skipped", { documentId: row.id, note: outcome.note })
		}
		if (outcome.nodes.length === 0) return

		// Level by level, so a node's members always exist before it points at them.
		const ordered = [...outcome.nodes].sort((a, b) => a.level - b.level)

		await knowledgeRepository.insertChunks(
			ordered.map((node, index) => ({
				id: node.id,
				organizationId: row.organizationId,
				knowledgeBaseId: row.knowledgeBaseId,
				documentId: row.id,
				ordinal: SUMMARY_ORDINAL_BASE + index,
				content: node.content,
				tokenCount: Math.ceil(node.content.length / 4),
				kind: "summary",
				level: node.level,
				digest: `summary:${node.id}`,
			})),
		)

		for (const node of ordered) {
			await knowledgeRepository.setChunkParent(node.id, node.memberChunkIds)
		}

		await upsertChunkVectors(
			target.dimensions,
			ordered.map((node, index) => ({
				chunkId: node.id,
				vector: node.vector,
				workspaceId: row.organizationId,
				knowledgeBaseId: row.knowledgeBaseId,
				documentId: row.id,
				ordinal: SUMMARY_ORDINAL_BASE + index,
			})),
		)

		if (inputTokens + outputTokens > 0) {
			await usageService.recordAndCharge({
				workspaceId: row.organizationId,
				operation: "ingestion",
				provider: chatModel.provider,
				model: chatModel.model,
				inputTokens,
				outputTokens,
				reference: `${input.reference}:raptor`,
				metadata: { documentId: row.id, summaries: ordered.length },
			})
		}
	},

	async stopRequested(documentId: string): Promise<boolean> {
		return knowledgeRepository.isCancelRequested(documentId)
	},

	/**
	 * Moves the progress bar. `null` leaves the fraction where it is — a stage
	 * change inside one task is worth naming without inventing a number for it.
	 */
	async progress(
		documentId: string,
		fraction: number | null,
		message: string,
		status?: string,
		extra: Partial<{ processBeganAt: Date; error: string | null }> = {},
	): Promise<void> {
		await knowledgeRepository.updateDocument(documentId, {
			...(fraction === null
				? {}
				: { progress: Math.min(1, Math.max(0, fraction)).toFixed(4) }),
			progressMessage: message.slice(0, 300),
			...(status ? { status } : {}),
			...extra,
		})
	},

	/**
	 * Records why a document is not indexed, on the document, in words the
	 * uploader can act on. Failures are a normal outcome here — an encrypted PDF,
	 * a provider outage — and hiding them in a log would leave a row stuck at
	 * "embedding" with nothing to explain it.
	 */
	async fail(documentId: string, message: string, startedAt?: number) {
		await knowledgeRepository.updateDocument(documentId, {
			status: STATUS.failed,
			error: message.slice(0, 500),
			progressMessage: "Indexing failed",
			...(startedAt ? { processDurationMs: Date.now() - startedAt } : {}),
		})

		// Re-read rather than threaded through: `fail` is reached from several
		// places, and every one of them would otherwise have to carry a workspace
		// id it does not currently need. `emit` never throws, so a subscriber's
		// problem cannot stop a document being marked failed (ADR-067).
		const row = await knowledgeRepository.findDocumentById(documentId)
		if (row) {
			await webhookService.emit(row.organizationId, "document.failed", {
				documentId,
				knowledgeBaseId: row.knowledgeBaseId,
				name: row.name,
				error: message.slice(0, 500),
			})
		}

		return { documentId, status: STATUS.failed, error: message }
	},

	/**
	 * A stop honoured between stages. The chunks already written stay: they are
	 * real passages, they were paid for, and deleting them would make cancelling
	 * a long ingestion strictly worse than letting it finish.
	 */
	async cancel(documentId: string, startedAt: number) {
		const keys = await knowledgeRepository.listChunkKeysOfDocument(documentId)
		await knowledgeRepository.updateDocument(documentId, {
			status: STATUS.cancelled,
			cancelRequested: false,
			progressMessage: `Cancelled with ${keys.length} passages indexed`,
			chunkCount: keys.length,
			processDurationMs: Date.now() - startedAt,
		})
		log.info("ingestion.cancelled", { documentId, chunks: keys.length })
		return { documentId, status: STATUS.cancelled, chunks: keys.length }
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
