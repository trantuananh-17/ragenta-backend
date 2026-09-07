import { isAppError } from "../../../shared/errors"
import { getObject, isStorageConfigured } from "../../../storage/objects"
import type { MessageAttachmentRow } from "../../attachment/attachment.repository"
import { attachmentService } from "../../attachment/attachment.service"
import type { OcrInput } from "../../vision/types"
import type { ToolContext, ToolResult } from "./types"

/**
 * Either the image both tools need, or the refusal they should hand back.
 *
 * A refusal rather than a throw, all the way down: a run that asked about an
 * attachment that is gone can still answer from something else, and an
 * exception would end it (see `types.ts`).
 */
export type LoadedImage =
	| { ok: true; row: MessageAttachmentRow; image: OcrInput }
	| { ok: false; refusal: ToolResult }

function refuse(content: string, metadata: Record<string, unknown>): LoadedImage {
	return { ok: false, refusal: { ok: false, content, metadata } }
}

/**
 * Resolve an attachment id the **model** produced, and fetch its bytes.
 *
 * The id is untrusted. It may have been read out of a document, echoed from a
 * web page or simply invented, so it is resolved only through
 * `attachmentService.findOrFail(workspaceId, …)`, which puts the workspace in
 * the WHERE clause — an id belonging to another tenant is a 404 here and never
 * an image this run gets to look at (`.claude/rules/security.md`). Nothing in
 * this file may ever take a workspace id from anywhere but `context`.
 */
export async function loadImageAttachment(
	context: ToolContext,
	attachmentId: string,
): Promise<LoadedImage> {
	if (!isStorageConfigured()) {
		return refuse(
			"This deployment has no object storage configured, so attachments cannot be read.",
			{ attachmentId, refused: "no_storage" },
		)
	}

	let row: MessageAttachmentRow
	try {
		row = await attachmentService.findOrFail(context.workspaceId, attachmentId)
	} catch (error) {
		return refuse(
			isAppError(error) ? error.message : "That attachment could not be read.",
			{ attachmentId, refused: "not_found" },
		)
	}

	if (row.kind !== "image") {
		return refuse(`Attachment ${attachmentId} is a ${row.kind}, not an image.`, {
			attachmentId,
			kind: row.kind,
			refused: "not_an_image",
		})
	}

	try {
		const bytes = await getObject(row.storageKey)
		return {
			ok: true,
			row,
			image: {
				dataBase64: bytes.toString("base64"),
				mimeType: row.mimeType,
				// Display and logging only — it never reaches a storage key.
				fileName: row.fileName,
			},
		}
	} catch (error) {
		return refuse(
			isAppError(error) ? error.message : "That image could not be fetched from storage.",
			{ attachmentId, refused: "storage_failed" },
		)
	}
}
