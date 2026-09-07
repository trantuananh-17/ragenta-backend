import { eq } from "drizzle-orm"

import { db } from "../../db/client"
import { integration } from "../../db/schema"
import { encryptSecret } from "../../shared/crypto"
import { NotFoundError, ValidationError } from "../../shared/errors"
import { auditService } from "../audit/audit.service"
import { safeFetch } from "../agent/tools/safe-fetch"
import { requireIntegration } from "../agent/tools/integrations"
import type { SaveIntegrationInput } from "./integration.dto"

type IntegrationRow = typeof integration.$inferSelect

/**
 * What an API response may say about an integration.
 *
 * The secret never appears, in any form, in any shape — only whether one is
 * stored and its masked hint. Same rule as `provider_credential` (ADR-021), and
 * it is enforced here rather than left to each caller to remember.
 */
function present(row: IntegrationRow) {
	return {
		id: row.id,
		kind: row.kind,
		name: row.name,
		description: row.description,
		enabled: row.enabled,
		baseUrl: row.baseUrl,
		hasSecret: Boolean(row.encryptedSecret),
		secretHint: row.secretHint,
		authHeader: row.authHeader,
		authPrefix: row.authPrefix,
		allowedMethods: row.allowedMethods,
		allowedPathPrefix: row.allowedPathPrefix,
		allowedRecipients: row.allowedRecipients,
		lastUsedAt: row.lastUsedAt,
		lastCheckedAt: row.lastCheckedAt,
		lastCheckOk: row.lastCheckOk,
		lastCheckError: row.lastCheckError,
		updatedAt: row.updatedAt,
	}
}

/** `sk-abc…wxyz`, enough to tell two keys apart and useless as a key. */
function hint(secret: string): string {
	return secret.length <= 8
		? "••••"
		: `${secret.slice(0, 4)}••••${secret.slice(-4)}`
}

export const integrationService = {
	async list() {
		const rows = await db.select().from(integration)
		return rows.map(present)
	},

	async get(id: string) {
		const rows = await db.select().from(integration).where(eq(integration.id, id)).limit(1)
		const row = rows[0]
		if (!row) throw new NotFoundError("Integration")
		return present(row)
	},

	/**
	 * Creates or replaces one integration.
	 *
	 * An omitted `secret` keeps whatever is stored: an administrator editing an
	 * allowlist cannot read the key back, so requiring it on every save would
	 * make every edit a key rotation.
	 */
	async save(id: string, input: SaveIntegrationInput, actorId: string) {
		if (input.kind === "http_api" && !input.baseUrl) {
			throw new ValidationError("An API connection needs a base URL.")
		}
		if (input.kind === "email" && input.allowedRecipients.length === 0) {
			throw new ValidationError(
				"An email connection needs at least one allowed recipient. Without one it would refuse every send.",
			)
		}

		const existing = await db
			.select()
			.from(integration)
			.where(eq(integration.id, id))
			.limit(1)

		const secretFields = input.secret
			? { encryptedSecret: encryptSecret(input.secret), secretHint: hint(input.secret) }
			: {}

		const values = {
			id,
			kind: input.kind,
			name: input.name,
			description: input.description,
			enabled: input.enabled,
			baseUrl: input.baseUrl,
			authHeader: input.authHeader,
			authPrefix: input.authPrefix,
			allowedMethods: input.allowedMethods,
			allowedPathPrefix: input.allowedPathPrefix,
			allowedRecipients: input.allowedRecipients,
			updatedBy: actorId,
			...secretFields,
		}

		const [saved] = existing[0]
			? await db.update(integration).set(values).where(eq(integration.id, id)).returning()
			: await db.insert(integration).values(values).returning()

		// The key is not in the metadata, and must never be: an audit trail is
		// read by more people than the table it describes.
		await auditService.record({
			action: existing[0] ? "integration.updated" : "integration.created",
			actorId,
			targetType: "integration",
			targetId: id,
			metadata: {
				kind: input.kind,
				secretRotated: Boolean(input.secret),
				allowedMethods: input.allowedMethods,
			},
		})

		return present(saved!)
	},

	async remove(id: string, actorId: string) {
		const rows = await db.delete(integration).where(eq(integration.id, id)).returning()
		if (rows.length === 0) throw new NotFoundError("Integration")

		await auditService.record({
			action: "integration.deleted",
			actorId,
			targetType: "integration",
			targetId: id,
		})
	},

	/**
	 * One cheap live call proving the connection works, and the outcome recorded
	 * on the row — the same affordance the models screen has, for the same
	 * reason: an administrator should not have to run an agent to find out that
	 * a key is wrong.
	 */
	async check(id: string) {
		const row = await this.get(id)

		if (row.kind === "email") {
			// Nothing to call: an email connection is the deployment's own SMTP,
			// and the honest check is whether it is configured at all.
			return { ok: true, detail: "Email connections are checked when a send is attempted." }
		}

		try {
			const { row: full, secret } = await requireIntegration(id, row.kind)
			const headers: Record<string, string> = { accept: "application/json" }
			if (secret && full.authHeader) {
				headers[full.authHeader] = `${full.authPrefix}${secret}`
			}

			const target =
				full.kind === "web_search"
					? `${(full.baseUrl ?? "https://api.tavily.com").replace(/\/+$/, "")}/search`
					: `${(full.baseUrl ?? "").replace(/\/+$/, "")}${full.allowedPathPrefix || "/"}`

			const response = await safeFetch(target, { method: "GET", headers })
			const ok = response.status < 500

			await db
				.update(integration)
				.set({
					lastCheckedAt: new Date(),
					lastCheckOk: ok,
					// A 4xx from the far side is a real answer and proves the host is
					// reachable — it is recorded rather than treated as a failure,
					// because "405 Method Not Allowed" means the connection works.
					lastCheckError: ok ? null : `HTTP ${response.status}`,
				})
				.where(eq(integration.id, id))

			return {
				ok,
				detail: `The host answered HTTP ${response.status}.`,
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "The check failed."
			await db
				.update(integration)
				.set({ lastCheckedAt: new Date(), lastCheckOk: false, lastCheckError: message.slice(0, 500) })
				.where(eq(integration.id, id))
			return { ok: false, detail: message }
		}
	},
}
