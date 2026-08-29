import { createMiddleware } from "hono/factory"

import type { WorkspaceRole } from "../../auth/permissions"
import { workspaceRepository } from "../../modules/workspace/workspace.repository"
import { ForbiddenError, NotFoundError } from "../../shared/errors"
import type { AppEnv } from "../types"
import { requireUser } from "../types"

/**
 * The tenant boundary. Every `/workspaces/:workspaceId/*` route goes through
 * this before its handler runs, so no handler ever has to remember to check
 * membership — and none of them may trust the id in the URL on its own.
 *
 * A workspace the caller is not a member of answers 404, not 403: a 403 would
 * confirm that the workspace exists.
 */
export const workspaceScope = createMiddleware<AppEnv>(async (c, next) => {
	const user = requireUser(c)
	const workspaceId = c.req.param("workspaceId")
	if (!workspaceId) throw new NotFoundError("Workspace")

	const membership = await workspaceRepository.findMembership(workspaceId, user.id)
	if (!membership) throw new NotFoundError("Workspace")

	c.set("membership", membership)
	c.set("logger", c.get("logger").child({ workspaceId }))
	await next()
})

/** Narrows a workspace-scoped route to specific roles. Runs after `workspaceScope`. */
export function requireWorkspaceRole(...allowed: WorkspaceRole[]) {
	return createMiddleware<AppEnv>(async (c, next) => {
		const membership = c.get("membership")
		if (!membership) throw new ForbiddenError()
		if (!(allowed as string[]).includes(membership.role)) {
			throw new ForbiddenError(
				`This action requires one of these workspace roles: ${allowed.join(", ")}.`,
			)
		}
		await next()
	})
}
