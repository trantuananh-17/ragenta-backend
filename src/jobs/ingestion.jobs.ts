import { z } from "zod"

import { QUEUE_INGESTION, getQueue } from "../queue/queues"

export const JOB_INGEST_DOCUMENT = "ingestion.ingest-document" as const

/**
 * The payload is one id. Everything else — which knowledge base, which embedding
 * model, what the chunk size is — is read from the database when the job runs,
 * so a job queued before a deploy acts on what is true afterwards.
 */
export const ingestDocumentPayload = z.object({
	documentId: z.string().min(1),
	workspaceId: z.string().min(1),
})

export type IngestDocumentPayload = z.infer<typeof ingestDocumentPayload>

/**
 * `attempt` makes the job id unique per re-index. Two uploads of the same
 * document should both run; a duplicate enqueue of the same attempt should not.
 * The job id is also what the credit charge is keyed on, so a retry of one
 * attempt never bills twice.
 */
export async function enqueueDocumentIngestion(
	payload: IngestDocumentPayload,
	attempt: number,
) {
	await getQueue(QUEUE_INGESTION).add(JOB_INGEST_DOCUMENT, payload, {
		jobId: `ingest:${payload.documentId}:${attempt}`,
		// Parsing and embedding are slow and mostly IO. Fewer attempts than the
		// default: a document that failed twice usually failed for a reason a
		// third try will hit as well, and each try costs a provider call.
		attempts: 3,
	})
}
