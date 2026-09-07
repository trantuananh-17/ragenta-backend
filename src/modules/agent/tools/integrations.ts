import { decryptSecret } from "../../../shared/crypto"
import { ValidationError } from "../../../shared/errors"
import {
	canWorkspaceUse,
	chooseConnection,
	connectionCandidateIds,
} from "../../integration/connection-scope"
import { integrationRepository } from "../../integration/integration.repository"
import type { IntegrationRow } from "../../integration/integration.repository"

export type { IntegrationRow }

/**
 * Reads a connection and its decrypted secret, for the moment a call is made
 * and for nothing else.
 *
 * The secret is returned here and nowhere near an API response — the same rule
 * `provider_credential` follows (ADR-021). Callers get a refusal rather than a
 * silent no-op when the row is missing or switched off: an agent that quietly
 * did nothing would look like an agent that decided not to.
 *
 * `workspaceId` is what makes a workspace's own connections usable without
 * making anyone else's reachable. The name comes from the model, so it is never
 * trusted as an id: it is turned into the two ids it could legitimately mean —
 * this workspace's, and the platform-wide one — and the query filters on the
 * owner as well, so a name crafted to look like another tenant's primary key
 * reads nothing. Omitting `workspaceId` resolves platform-wide rows only, which
 * is what the deployment-level tools and the admin API want.
 */
export async function requireIntegration(
	name: string,
	kind: string,
	workspaceId?: string,
): Promise<{
	row: IntegrationRow
	secret: string | null
}> {
	const rows = await integrationRepository.listResolvable(
		connectionCandidateIds(name, workspaceId),
		workspaceId,
	)
	// A workspace's own connection wins over a platform-wide one of the same
	// name, so a workspace that configured its own `email` sends through that.
	const row = chooseConnection(rows, name, workspaceId)

	if (!row) {
		throw new ValidationError(`No connection called "${name}" is available here.`)
	}
	if (row.kind !== kind) {
		throw new ValidationError(`The "${name}" connection is not a ${kind} connection.`)
	}
	if (!row.enabled) {
		throw new ValidationError(`The "${name}" connection is switched off.`)
	}

	return {
		row,
		secret: row.encryptedSecret ? decryptSecret(row.encryptedSecret) : null,
	}
}

/**
 * The connections an agent in this workspace could name, for the screen that
 * offers them: the platform-wide ones plus the workspace's own.
 */
export async function listIntegrations(
	workspaceId?: string,
	kind?: string,
): Promise<IntegrationRow[]> {
	const platform = await integrationRepository.listOwnedBy(null)
	const owned = workspaceId ? await integrationRepository.listOwnedBy(workspaceId) : []
	const rows = [...platform, ...owned].filter((row) => canWorkspaceUse(row, workspaceId))
	return kind ? rows.filter((row) => row.kind === kind) : rows
}

/** Records that a call went through it, so an unused connection is visible as one. */
export async function markUsed(id: string): Promise<void> {
	await integrationRepository.touch(id, { lastUsedAt: new Date() }).catch(() => {
		// Bookkeeping. A failure here must not fail the call it describes.
	})
}
