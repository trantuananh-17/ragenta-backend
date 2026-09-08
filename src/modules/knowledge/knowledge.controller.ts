import { Buffer } from "node:buffer"

import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import { ValidationError } from "../../shared/errors"
import { paginationQuerySchema } from "../../shared/pagination"
import {
	createKnowledgeBaseSchema,
	reindexDocumentSchema,
	updateKnowledgeBaseSchema,
	uploadDocumentSchema,
} from "./knowledge.dto"
import { knowledgeService } from "./knowledge.service"

/**
 * Multipart carries strings, so a nested value arrives as JSON in one field.
 * A malformed one is the caller's mistake and is reported as such rather than
 * being ignored, which would silently drop the settings they meant to send.
 */
function parseJsonField(value: unknown, field: string): unknown {
	if (typeof value !== "string" || value.trim().length === 0) return undefined
	try {
		return JSON.parse(value)
	} catch {
		throw new ValidationError(`\`${field}\` must be a JSON object.`)
	}
}

/** A body-less POST is legitimate for re-index, so an absent body is `{}`. */
async function readOptionalJson(c: AppContext): Promise<unknown> {
	if (!c.req.header("content-type")?.includes("application/json")) return {}
	return c.req.json().catch(() => ({}))
}

export const knowledgeController = {
	async listBases(c: AppContext) {
		const membership = requireMembership(c)
		const query = paginationQuerySchema.parse(c.req.query())
		return c.json(await knowledgeService.listBases(membership, query))
	},

	async createBase(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = createKnowledgeBaseSchema.parse(await c.req.json())
		return c.json(
			await knowledgeService.createBase(membership.organizationId, input, user.id),
			201,
		)
	},

	async getBase(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(
			await knowledgeService.getBase(membership.organizationId, requireParam(c, "baseId")),
		)
	},

	async updateBase(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = updateKnowledgeBaseSchema.parse(await c.req.json())
		return c.json(
			await knowledgeService.updateBase(
				membership.organizationId,
				requireParam(c, "baseId"),
				input,
				user.id,
			),
		)
	},

	async deleteBase(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		await knowledgeService.deleteBase(
			membership.organizationId,
			requireParam(c, "baseId"),
			user.id,
		)
		return c.body(null, 204)
	},

	async listDocuments(c: AppContext) {
		const membership = requireMembership(c)
		const query = paginationQuerySchema.parse(c.req.query())
		return c.json(
			await knowledgeService.listDocuments(
				membership.organizationId,
				requireParam(c, "baseId"),
				query,
			),
		)
	},

	/**
	 * `multipart/form-data`, not a JSON body with base64. Base64 inflates the
	 * payload by a third and forces the whole file through a JSON parser, and
	 * every HTTP client can already do multipart.
	 */
	async uploadDocument(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)

		const body = await c.req.parseBody()
		const file = body.file
		if (!(file instanceof File)) {
			throw new ValidationError("Attach the document as a `file` form field.")
		}

		return c.json(
			await knowledgeService.uploadDocument(
				membership.organizationId,
				requireParam(c, "baseId"),
				{
					name: file.name,
					// A browser leaves this empty for an unrecognised extension; the
					// extractor falls back to the filename, so an empty string is a
					// valid input rather than a reason to refuse.
					mimeType: file.type || "application/octet-stream",
					bytes: Buffer.from(await file.arrayBuffer()),
				},
				// The per-document overrides ride along as form fields, so an upload
				// stays one request. `parserConfig` is JSON because multipart has no
				// nested values.
				uploadDocumentSchema.parse({
					parserId: typeof body.parserId === "string" ? body.parserId : undefined,
					parserConfig: parseJsonField(body.parserConfig, "parserConfig"),
				}),
				user.id,
			),
			201,
		)
	},

	async getDocument(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(
			await knowledgeService.getDocument(
				membership.organizationId,
				requireParam(c, "documentId"),
			),
		)
	},

	async reindexDocument(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = reindexDocumentSchema.parse(await readOptionalJson(c))
		return c.json(
			await knowledgeService.reindexDocument(
				membership.organizationId,
				requireParam(c, "documentId"),
				input,
				user.id,
			),
		)
	},

	async cancelDocument(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		return c.json(
			await knowledgeService.cancelDocument(
				membership.organizationId,
				requireParam(c, "documentId"),
				user.id,
			),
		)
	},

	async listTasks(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(
			await knowledgeService.listTasks(
				membership.organizationId,
				requireParam(c, "documentId"),
			),
		)
	},

	listParsers(c: AppContext) {
		return c.json(knowledgeService.listParsers())
	},

	async deleteDocument(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		await knowledgeService.deleteDocument(
			membership.organizationId,
			requireParam(c, "documentId"),
			user.id,
		)
		return c.body(null, 204)
	},

	async listChunks(c: AppContext) {
		const membership = requireMembership(c)
		const query = paginationQuerySchema.parse(c.req.query())
		return c.json(
			await knowledgeService.listChunks(
				membership.organizationId,
				requireParam(c, "documentId"),
				query,
			),
		)
	},

	async downloadDocument(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(
			await knowledgeService.downloadUrl(
				membership.organizationId,
				requireParam(c, "documentId"),
			),
		)
	},
}
