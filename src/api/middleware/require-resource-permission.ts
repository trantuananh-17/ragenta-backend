import { createMiddleware } from "hono/factory"

import type { GrantableResourceType, WorkspacePermissionKey } from "../../auth/permissions"
import { permissionService } from "../../modules/rbac/permission.service"
import { ForbiddenError, NotFoundError } from "../../shared/errors"
import type { AppEnv } from "../types"
import { requireParam } from "../types"

/**
 * `requirePermission` narrowed to the one resource the path names.
 *
 * Only for routes whose path actually carries the resource's id — a project, a
 * knowledge base, an agent. A document's permissions are granted on its
 * knowledge base and its route names only the document, so that check belongs in
 * the service, after the repository has resolved which base it belongs to.
 *
 * The workspace comes from the proven membership, never from the path. The
 * resource id does come from the path, and that is safe here only because the
 * handler behind this goes on to fetch the resource workspace-scoped: a grant's
 * `resource_id` carries no foreign key, so a matching grant proves somebody wrote
 * a row, not that the row belongs to this tenant.
 */
export function requireResourcePermission(
	key: WorkspacePermissionKey,
	resourceType: GrantableResourceType,
	param: string,
) {
	return createMiddleware<AppEnv>(async (c, next) => {
		const membership = c.get("membership")
		if (!membership) throw new ForbiddenError()

		await permissionService.assertMemberOnResource(membership, key, {
			type: resourceType,
			id: requireParam(c, param),
		})

		await next()
	})
}

/**
 * The same check where the path does not name the resource the grant is written
 * against.
 *
 * A document's permissions are granted on its knowledge base, and its routes
 * carry only `:documentId` — so the base has to be looked up before the question
 * can be asked. Without this the base-level grants would be a control with a way
 * around it: deny somebody a knowledge base, and they could still open any
 * document in it by id.
 *
 * A document that does not exist in this workspace answers 404 from the resolver,
 * for the same reason `workspaceScope` does: a 403 would confirm it exists.
 */
export function requireResolvedResourcePermission(
	key: WorkspacePermissionKey,
	resourceType: GrantableResourceType,
	param: string,
	resolve: (workspaceId: string, id: string) => Promise<string | undefined>,
) {
	return createMiddleware<AppEnv>(async (c, next) => {
		const membership = c.get("membership")
		if (!membership) throw new ForbiddenError()

		const resourceId = await resolve(membership.organizationId, requireParam(c, param))
		if (!resourceId) throw new NotFoundError("Resource")

		await permissionService.assertMemberOnResource(membership, key, {
			type: resourceType,
			id: resourceId,
		})

		await next()
	})
}
