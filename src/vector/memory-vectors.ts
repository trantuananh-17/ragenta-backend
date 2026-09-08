import { getVectorClient } from "./qdrant"

/**
 * Where an agent's memories are indexed.
 *
 * **A separate collection from the document chunks, deliberately.** They could
 * have shared one with a `kind` in the payload, and that is exactly the design
 * where one forgotten filter makes a knowledge search answer from somebody's
 * private memory — or a recall answer from a document. `searchChunks` filters on
 * `workspaceId` and `knowledgeBaseId`, and a memory has neither, so it would have
 * needed a third clause added to a function whose whole safety property is that
 * every caller passes the same filter. Two collections cannot be confused by
 * omission (ADR-055).
 *
 * Still one collection per embedding width, for the reason ADR-020 gives, and
 * still tenant-separated by payload filter with an index on the field.
 */
export function memoryCollectionFor(dimensions: number): string {
	return `ragenta_memories_${dimensions}`
}

const ensured = new Set<string>()

export async function ensureMemoryCollection(dimensions: number): Promise<string> {
	const name = memoryCollectionFor(dimensions)
	if (ensured.has(name)) return name

	const qdrant = getVectorClient()
	const exists = await qdrant.collectionExists(name)

	if (!exists.exists) {
		await qdrant.createCollection(name, {
			vectors: { size: dimensions, distance: "Cosine" },
		})
	}

	// Without these a filtered search degrades to a full scan once the collection
	// is big enough for that to matter — which is when it is being used.
	for (const field of ["workspaceId", "agentId", "userId"]) {
		await qdrant
			.createPayloadIndex(name, { field_name: field, field_schema: "keyword", wait: true })
			.catch(() => {
				// Already-exists is the normal case on every boot after the first.
			})
	}

	ensured.add(name)
	return name
}

export interface MemoryVector {
	memoryId: string
	vector: number[]
	workspaceId: string
	agentId: string
	/** The person this memory is about, or `""` for one about the work itself. */
	userId: string
}

export async function upsertMemoryVectors(
	dimensions: number,
	vectors: MemoryVector[],
): Promise<void> {
	if (vectors.length === 0) return
	const collection = await ensureMemoryCollection(dimensions)

	await getVectorClient().upsert(collection, {
		wait: true,
		points: vectors.map((entry) => ({
			// The memory's own id, so rewriting one replaces its vector rather than
			// leaving an orphan the filter would still match.
			id: entry.memoryId,
			vector: entry.vector,
			payload: {
				workspaceId: entry.workspaceId,
				agentId: entry.agentId,
				userId: entry.userId,
			},
		})),
	})
}

export interface MemoryHit {
	memoryId: string
	score: number
}

/**
 * Recall, inside one agent.
 *
 * `workspaceId` is in the filter as well as `agentId` — redundant while an agent
 * belongs to one workspace, and still correct if that ever stops being true. A
 * recall that crossed tenants would put one customer's private notes in another's
 * prompt.
 *
 * `userIds` is how the two scopes are expressed. An agent-scoped recall passes
 * `[""]`, which matches only the memories about the work; a user-scoped one
 * passes `["", theirId]`, so a person gets the shared facts plus their own and
 * never somebody else's. There is no call shape that omits the clause.
 */
export async function searchMemories(
	dimensions: number,
	vector: number[],
	filter: { workspaceId: string; agentId: string; userIds: string[] },
	limit: number,
	scoreThreshold?: number,
): Promise<MemoryHit[]> {
	const collection = await ensureMemoryCollection(dimensions)

	const result = await getVectorClient().query(collection, {
		query: vector,
		filter: {
			must: [
				{ key: "workspaceId", match: { value: filter.workspaceId } },
				{ key: "agentId", match: { value: filter.agentId } },
				{ key: "userId", match: { any: filter.userIds } },
			],
		},
		limit,
		score_threshold: scoreThreshold,
		with_payload: false,
	})

	return result.points.map((point) => ({ memoryId: String(point.id), score: point.score }))
}

export async function deleteMemoryVectors(
	dimensions: number,
	memoryIds: string[],
): Promise<void> {
	if (memoryIds.length === 0) return
	const collection = await ensureMemoryCollection(dimensions)
	await getVectorClient().delete(collection, { wait: true, points: memoryIds })
}

/**
 * Everything an agent remembers, gone.
 *
 * By filter rather than by id, so it stays correct when the row count is larger
 * than a request can carry — and so deleting an agent cannot leave vectors
 * behind that a later agent reusing the id would inherit.
 */
export async function deleteAgentMemoryVectors(
	dimensions: number,
	workspaceId: string,
	agentId: string,
): Promise<void> {
	const collection = await ensureMemoryCollection(dimensions)
	await getVectorClient().delete(collection, {
		wait: true,
		filter: {
			must: [
				{ key: "workspaceId", match: { value: workspaceId } },
				{ key: "agentId", match: { value: agentId } },
			],
		},
	})
}
