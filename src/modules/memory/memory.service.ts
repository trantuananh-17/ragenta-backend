import { embedTexts, resolveEmbeddingModel } from "../../ai/embed"
import { logger } from "../../shared/logger"
import { newId } from "../../shared/id"
import {
	deleteAgentMemoryVectors,
	deleteMemoryVectors,
	searchMemories,
	upsertMemoryVectors,
} from "../../vector/memory-vectors"
import { isVectorStoreConfigured } from "../../vector/qdrant"
import { modelService } from "../model/model.service"
import { memoryRepository } from "./memory.repository"
import type { MemoryRow } from "./memory.repository"

const log = logger.child({ module: "memory" })

/**
 * The cap on what one agent may remember in one scope.
 *
 * Nothing else bounds this. An agent writing a memory a turn produces an index
 * nobody asked for, a recall that gets worse the longer it runs, and an
 * embedding bill that grows with usage rather than with value. Two hundred is
 * chosen to be far above what a useful agent accumulates and far below what
 * degrades a search; when it is reached, the least recently *recalled* memory is
 * dropped — the one nothing has needed.
 */
const MAX_MEMORIES_PER_SCOPE = 200

/** One memory is a sentence, not a document. Longer is a knowledge base's job. */
const MAX_MEMORY_LENGTH = 1_000

export interface MemoryScopeInput {
	workspaceId: string
	agentId: string
	/** NULL remembers about the work; a user id remembers about that person. */
	userId: string | null
}

export interface RecalledMemory {
	id: string
	content: string
	score: number
	createdAt: Date
}

export const memoryService = {
	/**
	 * Writes one thing an agent should remember.
	 *
	 * Returns the row, or `undefined` when there was nothing to write — an empty
	 * fact, or one already remembered verbatim. Rewriting an existing memory
	 * touches it rather than duplicating: a model reminded of the same fact three
	 * times should not make the index three times worse.
	 */
	async remember(
		scope: MemoryScopeInput,
		content: string,
		source: "tool" | "summary",
	): Promise<MemoryRow | undefined> {
		const text = content.trim().slice(0, MAX_MEMORY_LENGTH)
		if (text.length === 0) return undefined

		const existing = await memoryRepository.findIdentical(scope.agentId, scope.userId, text)
		if (existing) {
			await memoryRepository.touch([existing.id])
			return existing
		}

		const selection = (await modelService.getSettings(scope.workspaceId)).embedding
		const target = await resolveEmbeddingModel(selection.provider, selection.model)
		const { vectors } = await embedTexts(target, [text])
		const vector = vectors[0]
		if (!vector) return undefined

		const row = {
			id: newId(),
			organizationId: scope.workspaceId,
			agentId: scope.agentId,
			userId: scope.userId,
			content: text,
			source,
			embeddingModel: `${target.provider}/${target.model}`,
			dimensions: target.dimensions,
			metadata: {},
		}

		// The row first, then the vector. The other order can leave a vector whose
		// row never arrived — a hit that resolves to nothing, which is invisible
		// until a recall silently returns fewer memories than it found.
		await memoryRepository.insert(row)
		await upsertMemoryVectors(target.dimensions, [
			{
				memoryId: row.id,
				vector,
				workspaceId: scope.workspaceId,
				agentId: scope.agentId,
				userId: scope.userId ?? "",
			},
		])

		await memoryService.enforceCap(scope, target.dimensions)

		log.info("memory.written", { agentId: scope.agentId, source, scoped: scope.userId !== null })
		return { ...row, createdAt: new Date(), lastUsedAt: new Date() } as MemoryRow
	},

	/**
	 * What this agent remembers that bears on the question.
	 *
	 * Returns nothing rather than failing when the vector store is unconfigured or
	 * the embedding call refuses: memory is an enhancement, and a run that cannot
	 * recall should answer without it rather than not answer at all. The failure
	 * is logged, not swallowed.
	 */
	async recall(
		scope: MemoryScopeInput,
		question: string,
		limit: number,
	): Promise<RecalledMemory[]> {
		if (!isVectorStoreConfigured() || question.trim().length === 0) return []

		try {
			const selection = (await modelService.getSettings(scope.workspaceId)).embedding
			const target = await resolveEmbeddingModel(selection.provider, selection.model)
			const { vectors } = await embedTexts(target, [question])
			const vector = vectors[0]
			if (!vector) return []

			// `""` is the shared scope. A user-scoped recall reads the shared
			// memories plus their own; an agent-scoped one reads only the shared.
			const userIds = scope.userId === null ? [""] : ["", scope.userId]

			const hits = await searchMemories(
				target.dimensions,
				vector,
				{ workspaceId: scope.workspaceId, agentId: scope.agentId, userIds },
				limit,
			)
			if (hits.length === 0) return []

			const rows = await memoryRepository.findByIds(
				scope.workspaceId,
				scope.agentId,
				hits.map((hit) => hit.memoryId),
			)
			const byId = new Map(rows.map((row) => [row.id, row]))

			// A memory written under a different embedding model is skipped rather
			// than compared: vectors from two models are not comparable, so including
			// it returns nonsense rather than degrading. Its row survives, so a
			// re-embedding pass could bring it back.
			const recalled = hits
				.map((hit) => {
					const row = byId.get(hit.memoryId)
					if (!row || row.dimensions !== target.dimensions) return undefined
					return { id: row.id, content: row.content, score: hit.score, createdAt: row.createdAt }
				})
				.filter((entry): entry is RecalledMemory => entry !== undefined)

			await memoryRepository.touch(recalled.map((entry) => entry.id))
			return recalled
		} catch (error) {
			log.warn("memory.recall_failed", { agentId: scope.agentId, error: String(error) })
			return []
		}
	},

	async list(scope: MemoryScopeInput, limit = 100): Promise<MemoryRow[]> {
		return memoryRepository.list(scope.workspaceId, scope.agentId, scope.userId, limit)
	},

	async forget(scope: MemoryScopeInput, memoryId: string): Promise<boolean> {
		const removed = await memoryRepository.remove(scope.workspaceId, scope.agentId, memoryId)
		if (!removed) return false
		await deleteMemoryVectors(removed.dimensions, [removed.id]).catch((error: unknown) => {
			// The row is gone, so the memory is forgotten as far as every reader is
			// concerned; an orphan vector resolves to nothing on recall. Worth a log,
			// not worth failing a deletion the caller already saw succeed.
			log.warn("memory.vector_delete_failed", { memoryId, error: String(error) })
		})
		return true
	},

	/** Everything, for one scope. What "forget what you know about me" runs. */
	async forgetAll(scope: MemoryScopeInput): Promise<number> {
		const removed = await memoryRepository.removeAll(
			scope.workspaceId,
			scope.agentId,
			scope.userId,
		)
		const widths = new Set(removed.map((row) => row.dimensions))

		for (const dimensions of widths) {
			const ids = removed.filter((row) => row.dimensions === dimensions).map((row) => row.id)
			await deleteMemoryVectors(dimensions, ids).catch((error: unknown) => {
				log.warn("memory.vector_delete_failed", { agentId: scope.agentId, error: String(error) })
			})
		}

		return removed.length
	},

	/** Deleting an agent takes its vectors with it, by filter rather than by id. */
	async forgetAgent(workspaceId: string, agentId: string, dimensions: number): Promise<void> {
		await deleteAgentMemoryVectors(dimensions, workspaceId, agentId).catch((error: unknown) => {
			log.warn("memory.vector_delete_failed", { agentId, error: String(error) })
		})
	},

	async enforceCap(scope: MemoryScopeInput, dimensions: number): Promise<void> {
		const held = await memoryRepository.count(scope.agentId, scope.userId)
		if (held <= MAX_MEMORIES_PER_SCOPE) return

		const evict = await memoryRepository.oldestUnused(
			scope.agentId,
			scope.userId,
			held - MAX_MEMORIES_PER_SCOPE,
		)
		for (const row of evict) {
			await memoryRepository.remove(scope.workspaceId, scope.agentId, row.id)
		}
		await deleteMemoryVectors(
			dimensions,
			evict.map((row) => row.id),
		).catch(() => undefined)

		log.info("memory.evicted", { agentId: scope.agentId, count: evict.length })
	},
}
