import type { integration } from "../../db/schema/integration.schema"

/**
 * Who owns a connection, and which ones a workspace is allowed to name.
 *
 * Deliberately free of the database, the request and the config — the import of
 * the row type is erased at compile time, so nothing here reaches `config/env`.
 * This is the tenant boundary for credentials, so it is the part that has to be
 * testable on its own. Every rule about *which* connection a run may resolve
 * lives here, and is applied by `integrations.ts` and the repository together.
 */

/** Only the columns the scope rules read, so a caller can pass a partial row. */
export type ScopedRow = Pick<
	typeof integration.$inferSelect,
	"id" | "organizationId"
>

/**
 * Separates a workspace's own connection ids from platform-wide ones inside a
 * single primary key.
 *
 * A colon is banned in a slug (see `connectionSlugSchema` in the DTO) so a
 * composed id can never be forged: `<workspaceId>:<slug>` has exactly one
 * meaning, and a slug cannot smuggle a second separator to impersonate another
 * workspace's row.
 */
const SEPARATOR = ":"

export function composeConnectionId(organizationId: string, slug: string): string {
	return `${organizationId}${SEPARATOR}${slug}`
}

/**
 * The name an agent and an API response use: the slug for a workspace-owned
 * row, the id itself for a platform-wide one. The stored primary key is an
 * implementation detail of tenancy and is never the thing anyone types.
 */
export function connectionName(row: ScopedRow): string {
	if (!row.organizationId) return row.id
	const prefix = `${row.organizationId}${SEPARATOR}`
	return row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id
}

/**
 * The stored ids a given name could legitimately mean for this workspace, most
 * specific first.
 *
 * With no workspace — the admin API, and the deployment-level tools that have
 * no run behind them — only the platform-wide name is a candidate.
 */
export function connectionCandidateIds(name: string, workspaceId?: string): string[] {
	return workspaceId ? [composeConnectionId(workspaceId, name), name] : [name]
}

/**
 * Whether a row is one this workspace may use at all.
 *
 * The core isolation property: platform-wide rows plus this workspace's own,
 * and nothing else. A run with no workspace sees only platform-wide rows. This
 * is checked after the query as well as in it — a candidate id is derived from
 * caller input, and a predicate that is only in the SQL is one refactor away
 * from not being anywhere.
 */
export function canWorkspaceUse(row: ScopedRow, workspaceId?: string): boolean {
	if (row.organizationId === null) return true
	return workspaceId !== undefined && row.organizationId === workspaceId
}

/**
 * Picks the connection a name resolves to: the workspace's own wins over the
 * platform-wide one of the same name, so a workspace that configured its own
 * `email` connection sends through that and not the deployment's.
 */
export function chooseConnection<T extends ScopedRow>(
	rows: T[],
	name: string,
	workspaceId?: string,
): T | undefined {
	const usable = rows.filter((row) => canWorkspaceUse(row, workspaceId))
	const owned = usable.find(
		(row) => row.organizationId !== null && connectionName(row) === name,
	)
	if (owned) return owned
	return usable.find((row) => row.organizationId === null && row.id === name)
}

/**
 * What an API response may say about a connection.
 *
 * The secret never appears, in any form, in any shape — only whether one is
 * stored and its masked hint. Same rule as `provider_credential` (ADR-021), and
 * it is enforced here rather than left to each caller to remember: this is the
 * only function that turns a row into a response body, so there is one place to
 * check that the ciphertext is not in it.
 */
export function presentConnection(row: typeof integration.$inferSelect) {
	return {
		id: connectionName(row),
		scope: row.organizationId ? ("workspace" as const) : ("platform" as const),
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
