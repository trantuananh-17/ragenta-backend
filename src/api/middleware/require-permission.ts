import { createMiddleware } from "hono/factory"

import type { WorkspacePermissionKey } from "../../auth/permissions"
import { permissionService } from "../../modules/rbac/permission.service"
import { ForbiddenError } from "../../shared/errors"
import type { AppEnv } from "../types"

/**
 * Narrows a workspace-scoped route to callers holding a permission. Runs after
 * `workspaceScope`, which is what proved the membership.
 *
 * This replaced `requireWorkspaceRole`, which compared a string against
 * `member.role` at 37 call sites. Two middlewares asking the same question two
 * ways is how the two answers drift apart, so the old one is gone rather than
 * kept as an alias — and the roles that used to be listed here are now rows,
 * editable without a deploy (ADR-046).
 *
 * Naming several permissions requires **all** of them. There is no "any of"
 * variant, because no route needs one and an authorization helper that is
 * sometimes a disjunction is one somebody will eventually read as a conjunction.
 */
export function requirePermission(...required: WorkspacePermissionKey[]) {
	return createMiddleware<AppEnv>(async (c, next) => {
		const membership = c.get("membership")
		if (!membership) throw new ForbiddenError()

		const held = await permissionService.forMember(membership.id)
		const missing = required.filter((key) => !held.has(key))

		if (missing.length > 0) {
			throw new ForbiddenError(
				`This action requires ${
					missing.length === 1 ? "the permission" : "these permissions"
				}: ${missing.join(", ")}.`,
			)
		}

		await next()
	})
}
