import type { AttachmentExtraction } from "../../db/schema"
import type { MessageAttachmentRow } from "./attachment.repository"

/**
 * What an attachment looks like from outside.
 *
 * `storageKey` is the one column that is never in it. It is a bucket path, and
 * handing it out gives away everything a caller would need the day a bucket is
 * misconfigured for direct reads or a signing key leaks. The content endpoint
 * mints a short-lived URL from it instead, per request.
 */
export interface AttachmentResponse {
	id: string
	conversationId: string | null
	messageId: string | null
	kind: string
	fileName: string
	mimeType: string
	sizeBytes: number
	width: number | null
	height: number | null
	durationMs: number | null
	status: string
	error: string | null
	extracted: AttachmentExtraction | null
	createdAt: Date
}

export function toAttachmentResponse(row: MessageAttachmentRow): AttachmentResponse {
	return {
		id: row.id,
		conversationId: row.conversationId,
		messageId: row.messageId,
		kind: row.kind,
		fileName: row.fileName,
		mimeType: row.mimeType,
		sizeBytes: row.sizeBytes,
		width: row.width,
		height: row.height,
		durationMs: row.durationMs,
		status: row.status,
		error: row.error,
		extracted: row.extracted,
		createdAt: row.createdAt,
	}
}
