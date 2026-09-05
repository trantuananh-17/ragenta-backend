import type { Job } from "bullmq"

import { JOB_INGEST_DOCUMENT, ingestDocumentPayload } from "../../jobs/ingestion.jobs"
import { ingestionService } from "../../modules/knowledge/ingestion.service"

export async function processIngestionJob(job: Job) {
	switch (job.name) {
		case JOB_INGEST_DOCUMENT: {
			const payload = ingestDocumentPayload.parse(job.data)
			// The job id is the credit-charge reference: BullMQ keeps it across the
			// retries of one job, so a document that fails after embedding is not
			// billed a second time when it succeeds.
			return ingestionService.ingestDocument(payload.documentId, {
				reference: `ingest:${job.id ?? payload.documentId}`,
			})
		}
		default:
			throw new Error(`Unknown ingestion job: ${job.name}`)
	}
}
