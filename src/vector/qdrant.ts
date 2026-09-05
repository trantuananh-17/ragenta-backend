import { QdrantClient } from "@qdrant/js-client-rest"

import { env } from "../config/env"
import { AppError } from "../shared/errors"
import { logger } from "../shared/logger"

const log = logger.child({ component: "qdrant" })

/**
 * The vector store.
 *
 * **One collection per embedding width, workspace isolation by payload filter**
 * (ADR-020). Two decisions in one sentence, and both have a reason:
 *
 *  - *Per width*, because a collection has a fixed vector size. A deployment
 *    offering both text-embedding-3-small (1536) and -large (3072) needs two,
 *    and keying on the number rather than the model name means two models of
 *    the same width share one index without a migration.
 *  - *Not per workspace*, because Qdrant holds an index per collection and a
 *    few thousand tenants would be a few thousand indexes. The supported answer
 *    is a payload index on the tenant field, which is what `ensureCollection`
 *    creates. Every search here passes that filter — there is no code path that
 *    queries without one, which is the property that makes it safe.
 */
export class VectorStoreUnavailableError extends AppError {
	constructor() {
		super(
			"VECTOR_STORE_UNAVAILABLE",
			"QDRANT_URL is not configured, so this deployment cannot index or retrieve documents.",
			503,
		)
	}
}

let client: QdrantClient | undefined

function getClient(): QdrantClient {
	if (!env.qdrant) throw new VectorStoreUnavailableError()
	client ??= new QdrantClient({
		url: env.qdrant.url,
		apiKey: env.qdrant.apiKey,
		checkCompatibility: false,
	})
	return client
}

export function isVectorStoreConfigured(): boolean {
	return env.qdrant !== undefined
}

export function collectionFor(dimensions: number): string {
	return `ragenta_chunks_${dimensions}`
}

/** Collections already confirmed this process. Creating one is idempotent but not free. */
const ensured = new Set<string>()

export async function ensureCollection(dimensions: number): Promise<string> {
	const name = collectionFor(dimensions)
	if (ensured.has(name)) return name

	const qdrant = getClient()
	const exists = await qdrant.collectionExists(name)

	if (!exists.exists) {
		await qdrant.createCollection(name, {
			vectors: { size: dimensions, distance: "Cosine" },
		})
		log.info("qdrant.collection_created", { collection: name, dimensions })
	}

	// Without these a filtered search degrades into a full scan the moment the
	// collection is large enough to matter — which is exactly when it is used.
	for (const field of ["workspaceId", "knowledgeBaseId", "documentId"]) {
		await qdrant
			.createPayloadIndex(name, { field_name: field, field_schema: "keyword", wait: true })
			.catch((error: unknown) => {
				// Already-exists is the normal case on every boot after the first.
				log.debug("qdrant.payload_index_skipped", { collection: name, field, error })
			})
	}

	ensured.add(name)
	return name
}

export interface ChunkVector {
	chunkId: string
	vector: number[]
	workspaceId: string
	knowledgeBaseId: string
	documentId: string
	ordinal: number
}

export async function upsertChunkVectors(
	dimensions: number,
	vectors: ChunkVector[],
): Promise<void> {
	if (vectors.length === 0) return
	const collection = await ensureCollection(dimensions)

	await getClient().upsert(collection, {
		wait: true,
		points: vectors.map((entry) => ({
			// The chunk's own id. Qdrant accepts a UUID as a point id, and reusing
			// it makes a re-ingested chunk overwrite its old vector instead of
			// leaving an orphan the filter would still match.
			id: entry.chunkId,
			vector: entry.vector,
			payload: {
				workspaceId: entry.workspaceId,
				knowledgeBaseId: entry.knowledgeBaseId,
				documentId: entry.documentId,
				ordinal: entry.ordinal,
			},
		})),
	})
}

export interface VectorHit {
	chunkId: string
	documentId: string
	score: number
}

/**
 * Dense search inside one knowledge base.
 *
 * `workspaceId` is in the filter as well as `knowledgeBaseId`, which is
 * redundant while every knowledge base belongs to one workspace — and stays
 * correct if that ever stops being true. A retrieval that crosses tenants is
 * the worst bug this system could have; one extra clause is cheap insurance.
 */
export async function searchChunks(
	dimensions: number,
	vector: number[],
	filter: { workspaceId: string; knowledgeBaseId: string; documentIds?: string[] },
	limit: number,
	scoreThreshold?: number,
): Promise<VectorHit[]> {
	const collection = await ensureCollection(dimensions)

	const must: Record<string, unknown>[] = [
		{ key: "workspaceId", match: { value: filter.workspaceId } },
		{ key: "knowledgeBaseId", match: { value: filter.knowledgeBaseId } },
	]
	if (filter.documentIds?.length) {
		must.push({ key: "documentId", match: { any: filter.documentIds } })
	}

	// `query` rather than the removed `search`: the universal points endpoint as
	// of Qdrant 1.10, and the only one the 1.19 client exposes.
	const result = await getClient().query(collection, {
		query: vector,
		filter: { must },
		limit,
		score_threshold: scoreThreshold,
		with_payload: ["documentId"],
	})

	return result.points.map((point) => ({
		chunkId: String(point.id),
		documentId: String((point.payload as { documentId?: string } | null)?.documentId ?? ""),
		score: point.score,
	}))
}

export async function deleteDocumentVectors(
	dimensions: number,
	workspaceId: string,
	documentId: string,
): Promise<void> {
	const collection = await ensureCollection(dimensions)
	await getClient().delete(collection, {
		wait: true,
		filter: {
			must: [
				{ key: "workspaceId", match: { value: workspaceId } },
				{ key: "documentId", match: { value: documentId } },
			],
		},
	})
}

export async function deleteKnowledgeBaseVectors(
	dimensions: number,
	workspaceId: string,
	knowledgeBaseId: string,
): Promise<void> {
	const collection = await ensureCollection(dimensions)
	await getClient().delete(collection, {
		wait: true,
		filter: {
			must: [
				{ key: "workspaceId", match: { value: workspaceId } },
				{ key: "knowledgeBaseId", match: { value: knowledgeBaseId } },
			],
		},
	})
}

export async function checkVectorStore(): Promise<boolean> {
	if (!env.qdrant) return false
	try {
		await getClient().getCollections()
		return true
	} catch {
		return false
	}
}
