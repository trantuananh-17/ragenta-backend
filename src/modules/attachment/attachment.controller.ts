import { Buffer } from "node:buffer"

import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import { ValidationError } from "../../shared/errors"
import { attachmentService } from "./attachment.service"

export const attachmentController = {
	/**
	 * `multipart/form-data`, for the same reason a document upload is: base64 in a
	 * JSON body inflates the payload by a third and pushes the whole file through
	 * a JSON parser.
	 *
	 * One endpoint for images and recordings alike: the kind is decided from the
	 * bytes, so there is nothing for a caller to declare and nothing for it to get
	 * wrong.
	 */
	async upload(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)

		const body = await c.req.parseBody()
		const file = body.file
		if (!(file instanceof File)) {
			throw new ValidationError("Attach the file as a `file` form field.")
		}

		return c.json(
			await attachmentService.upload(
				membership.organizationId,
				{
					name: file.name,
					declaredMimeType: file.type,
					bytes: Buffer.from(await file.arrayBuffer()),
				},
				user.id,
			),
			201,
		)
	},

	async get(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(
			await attachmentService.get(membership.organizationId, requireParam(c, "attachmentId")),
		)
	},

	async content(c: AppContext) {
		const membership = requireMembership(c)
		const { url } = await attachmentService.contentUrl(
			membership.organizationId,
			requireParam(c, "attachmentId"),
		)
		// The presigned URL is a bearer credential with a short life; nothing on the
		// way back may keep the redirect that carries it.
		c.header("Cache-Control", "private, no-store")
		return c.redirect(url, 302)
	},

	async remove(c: AppContext) {
		const membership = requireMembership(c)
		await attachmentService.remove(
			membership.organizationId,
			requireParam(c, "attachmentId"),
		)
		return c.body(null, 204)
	},
}
