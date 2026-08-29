import { asc, eq } from "drizzle-orm"

import { db } from "../db/client"
import { member } from "../db/schema"

/**
 * The workspace a brand-new session starts in.
 *
 * Better Auth's organization plugin never sets `session.activeOrganizationId` at
 * creation — the only writer is the client calling `setActive` after sign-in.
 * That leaves a window, measured in seconds, where a session is authenticated
 * but scoped to no workspace, and every workspace-scoped request in it fails.
 * Seeding the column when the session row is created closes the window at the
 * source; the client is still free to switch workspaces afterwards.
 *
 * Earliest membership wins, with the id as tiebreak, so a returning user always
 * lands in the same workspace.
 *
 * Queried through Drizzle rather than `auth.api.*`: this runs from a hook inside
 * the object passed to `betterAuth(...)`, so touching the `auth` instance would
 * reference it before construction.
 *
 * Never throws. A user who has no workspace yet is the normal case, and a
 * database hiccup must degrade to "no active workspace" rather than fail sign-in.
 */
export async function defaultWorkspaceId(userId: string): Promise<string | undefined> {
	try {
		const rows = await db
			.select({ organizationId: member.organizationId })
			.from(member)
			.where(eq(member.userId, userId))
			.orderBy(asc(member.createdAt), asc(member.id))
			.limit(1)
		return rows[0]?.organizationId
	} catch {
		return undefined
	}
}
