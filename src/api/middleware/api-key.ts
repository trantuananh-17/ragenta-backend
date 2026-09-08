import { createMiddleware } from "hono/factory"

import { apiKeyService } from "../../modules/apikey/apikey.service"
import { keyFromHeader } from "../../modules/apikey/key-format"
import { NotFoundError, UnauthorizedError } from "../../shared/errors"
import type { AppEnv } from "../types"

/**
 * Lets a program authenticate instead of a person.
 *
 * Runs **before** `attachSession` on the routes that accept a key, and does
 * nothing when the request carries no `Bearer rag_…` — so a browser with a
 * session cookie is unaffected and the two mechanisms never both apply.
 *
 * What it sets is deliberate:
 *
 *  - `membership`, so every existing `workspaceScope`-shaped assumption holds and
 *    a key cannot reach outside the workspace its row names.
 *  - `keyPermissions`, which `requirePermission` reads **instead of** the
 *    membership's own set. A key is a *narrowing* of what its creator may do, so
 *    checking the membership's permissions would hand every key everything its
 *    author has (ADR-062).
 *  - `user`, from the membership, so the audit trail and the usage ledger have an
 *    actor rather than a null that means "we do not know".
 */
export const attachApiKey = createMiddleware<AppEnv>(async (c, next) => {
	const presented = keyFromHeader(c.req.header("authorization"))
	if (!presented) {
		await next()
		return
	}

	const caller = await apiKeyService.resolve(presented)
	// One answer for revoked, expired, unknown and orphaned. Telling them apart
	// says which half a probe got right.
	if (!caller) throw new UnauthorizedError("That API key is not valid.")

	c.set("membership", caller.membership)
	c.set("keyPermissions", caller.permissions)
	c.set("apiKeyId", caller.key.id)
	c.set("logger", c.get("logger").child({ apiKeyId: caller.key.id }))

	await next()
})

/**
 * The workspace in the path has to be the one the key belongs to.
 *
 * `workspaceScope` proves a *session's* membership by querying it; a key has
 * already been resolved to exactly one membership, so what is left is checking
 * the caller did not point it at a different workspace. 404, not 403 — the same
 * answer `workspaceScope` gives, because a 403 confirms the workspace exists.
 */
export const apiKeyWorkspaceScope = createMiddleware<AppEnv>(async (c, next) => {
	const membership = c.get("membership")
	const workspaceId = c.req.param("workspaceId")

	if (!membership || !workspaceId || membership.organizationId !== workspaceId) {
		throw new NotFoundError("Workspace")
	}

	c.set("logger", c.get("logger").child({ workspaceId }))
	await next()
})
