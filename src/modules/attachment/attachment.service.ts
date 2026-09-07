import type { Buffer } from "node:buffer"

import { AppError, ConflictError, NotFoundError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import {
	attachmentKey,
	isStorageConfigured,
	presignedDownloadUrl,
	putObject,
	removeObject,
} from "../../storage/objects"
import { StorageUnavailableError } from "../../storage/objects"
import { toAttachmentResponse } from "./attachment.dto"
import { attachmentRepository } from "./attachment.repository"
import { sniffImageMimeType, validateAudioUpload, validateImageUpload } from "./validate"

const log = logger.child({ module: "attachment" })

export interface UploadedFile {
	/** Display only. It never reaches a path — the key comes from the generated id. */
	name: string
	/** What the caller claimed. Kept for the mismatch log and for nothing else. */
	declaredMimeType: string
	bytes: Buffer
}

/** What the bytes turned out to be, and the per-kind columns that follow from it. */
interface ValidatedUpload {
	kind: "image" | "audio"
	mimeType: string
	sizeBytes: number
	width: number | null
	height: number | null
	durationMs: number | null
}

/**
 * One upload path for every kind, because there is one table and one binding
 * path (ADR-037). The image sniff runs first and settles the RIFF container both
 * families share — a WAV cannot pass it, because `sniffImageMimeType` requires
 * the WEBP form word as well as the RIFF prefix.
 */
function validateUpload(bytes: Buffer): ValidatedUpload {
	if (sniffImageMimeType(bytes)) {
		const image = validateImageUpload(bytes)
		return { kind: "image", ...image, durationMs: null }
	}

	const audio = validateAudioUpload(bytes)
	return { kind: "audio", ...audio, width: null, height: null }
}

/**
 * Uploads are their own request, so an attachment exists before the message it
 * belongs to does. Nothing here binds one — that happens at send time, in chat,
 * which re-checks workspace ownership then. An unbound row is not permission to
 * attach it to anything.
 *
 * Deliberately not audited: this is one row per file pasted into a composer,
 * and `.claude/rules/security.md` reserves the trail for actions that move
 * money, permissions or people.
 */
export const attachmentService = {
	/**
	 * `actorId` is nullable because an agent run may have no human actor — an
	 * API-key or scheduled run. `message_attachment.user_id` is a nullable FK,
	 * so null is the correct value there; an empty string would violate it.
	 */
	async upload(workspaceId: string, file: UploadedFile, actorId: string | null) {
		if (!isStorageConfigured()) throw new StorageUnavailableError()

		const upload = validateUpload(file.bytes)
		if (file.declaredMimeType && file.declaredMimeType !== upload.mimeType) {
			// Not refused on its own: browsers get this wrong for renamed files often
			// enough. It is logged because a run of them is what a probe looks like.
			log.warn("attachment.mime_mismatch", {
				workspaceId,
				declared: file.declaredMimeType,
				sniffed: upload.mimeType,
			})
		}

		const id = newId()
		const key = attachmentKey(workspaceId, id)
		await putObject(key, file.bytes, upload.mimeType)

		const row = await attachmentRepository.insert({
			id,
			organizationId: workspaceId,
			userId: actorId,
			kind: upload.kind,
			storageKey: key,
			fileName: file.name.slice(0, 300),
			mimeType: upload.mimeType,
			sizeBytes: upload.sizeBytes,
			width: upload.width,
			height: upload.height,
			durationMs: upload.durationMs,
			// Ready even for audio: the object is stored and playable. Transcription
			// is a separate, billed request, and it is what moves this to processing.
			status: "ready",
		})
		if (!row) {
			throw new AppError(
				"ATTACHMENT_NOT_STORED",
				"The file was uploaded but could not be recorded.",
				500,
			)
		}

		return toAttachmentResponse(row)
	},

	/** The scoped read every other method is built on. */
	async findOrFail(workspaceId: string, attachmentId: string) {
		const row = await attachmentRepository.find(workspaceId, attachmentId)
		if (!row) throw new NotFoundError("Attachment")
		return row
	},

	async get(workspaceId: string, attachmentId: string) {
		return toAttachmentResponse(await this.findOrFail(workspaceId, attachmentId))
	},

	/**
	 * A presigned URL to redirect to, rather than the bytes through this process.
	 * Streaming an image would occupy a Node process for the whole transfer while
	 * the object store does that better, and a redirect keeps the endpoint usable
	 * as an image source — the browser follows it and sends its session cookie to
	 * us, not to the bucket. The expiry is short because the URL that comes back
	 * is its own authorisation.
	 */
	async contentUrl(workspaceId: string, attachmentId: string) {
		const row = await this.findOrFail(workspaceId, attachmentId)
		return { url: await presignedDownloadUrl(row.storageKey) }
	},

	/**
	 * Only while nothing points at it. Once a turn has been sent the image is part
	 * of what was said, and removing it would leave a saved message referring to
	 * an object that is not there; deleting the message is how it goes away.
	 */
	async remove(workspaceId: string, attachmentId: string) {
		const row = await this.findOrFail(workspaceId, attachmentId)
		if (row.messageId) {
			throw new ConflictError(
				"This image is part of a message that has been sent. Delete the message instead.",
			)
		}

		if (!(await attachmentRepository.deleteUnbound(workspaceId, attachmentId))) {
			throw new ConflictError(
				"This image was attached to a message while it was being deleted.",
			)
		}

		// The row goes first because it is what everything else reads: a leftover
		// object is a leak a bucket sweep can clear, a leftover row is a broken
		// image in a thread.
		await removeObject(row.storageKey).catch((error: unknown) => {
			log.warn("storage.delete_failed", { key: row.storageKey, error: String(error) })
		})
	},
}
