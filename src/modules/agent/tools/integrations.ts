import { eq } from "drizzle-orm"

import { db } from "../../../db/client"
import { integration } from "../../../db/schema"
import { decryptSecret } from "../../../shared/crypto"
import { ValidationError } from "../../../shared/errors"

export type IntegrationRow = typeof integration.$inferSelect

/**
 * Reads an integration and its decrypted secret, for the moment a call is made
 * and for nothing else.
 *
 * The secret is returned here and nowhere near an API response — the same rule
 * `provider_credential` follows (ADR-021). Callers get a refusal rather than a
 * silent no-op when the row is missing or switched off: an agent that quietly
 * did nothing would look like an agent that decided not to.
 */
export async function requireIntegration(id: string, kind: string): Promise<{
	row: IntegrationRow
	secret: string | null
}> {
	const rows = await db.select().from(integration).where(eq(integration.id, id)).limit(1)
	const row = rows[0]

	if (!row) {
		throw new ValidationError(
			`No integration called "${id}" is configured on this deployment.`,
		)
	}
	if (row.kind !== kind) {
		throw new ValidationError(`The "${id}" integration is not a ${kind} connection.`)
	}
	if (!row.enabled) {
		throw new ValidationError(`The "${id}" integration is switched off.`)
	}

	return {
		row,
		secret: row.encryptedSecret ? decryptSecret(row.encryptedSecret) : null,
	}
}

/** The integrations an agent could name, for the screen that offers them. */
export async function listIntegrations(kind?: string): Promise<IntegrationRow[]> {
	const rows = await db.select().from(integration)
	return kind ? rows.filter((row) => row.kind === kind) : rows
}

/** Records that a call went through it, so an unused integration is visible as one. */
export async function markUsed(id: string): Promise<void> {
	await db
		.update(integration)
		.set({ lastUsedAt: new Date() })
		.where(eq(integration.id, id))
		.catch(() => {
			// Bookkeeping. A failure here must not fail the call it describes.
		})
}
