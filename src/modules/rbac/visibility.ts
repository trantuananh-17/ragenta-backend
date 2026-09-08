import { sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"

import type { GrantableResourceType, WorkspacePermissionKey } from "../../auth/permissions"
import { resourceGrant } from "../../db/schema"
import type { MembershipRow } from "../workspace/workspace.repository"
import { permissionService } from "./permission.service"
import { rbacRepository } from "./rbac.repository"
import { visibilityMode } from "./visibility-mode"

/**
 * The condition that keeps a list from naming a resource the caller cannot open.
 *
 * **In SQL, not in memory.** Filtering a fetched page leaves the page counts
 * wrong — twenty rows requested, seventeen shown, and a "next" button that
 * eventually lands on an empty page. That is the kind of half-fix that looks
 * finished, which is why ADR-048 deferred this rather than shipping it.
 *
 * Two shapes, chosen by `visibility-mode.ts`, which is tested to agree with the
 * row-level check exactly: a list that names something the caller cannot open is
 * a disclosure, and one that hides something they can open is a bug report
 * nobody can reproduce.
 *
 * The subquery carries the workspace id for the same reason the row-level lookup
 * does: `resource_grant.resource_id` is polymorphic and carries no foreign key,
 * so the tenant filter is the only thing keeping one workspace's grant from
 * matching another's resource that happens to share an id.
 */
export interface Visibility {
	/** Applied to the list's own WHERE, against the table's id column. */
	condition: (idColumn: PgColumn) => SQL
	/** True when nothing is filtered, so a caller can skip the join entirely. */
	unrestricted: boolean
}

export async function visibilityFor(
	membership: MembershipRow,
	resourceType: GrantableResourceType,
	permissionKey: WorkspacePermissionKey,
): Promise<Visibility> {
	const [held, roleIds] = await Promise.all([
		permissionService.forMember(membership.id),
		rbacRepository.listMemberRoleIds(membership.id),
	])

	const grantedByRole = held.has(permissionKey)
	const mode = visibilityMode(grantedByRole)

	const subjectMatch = sql`(
		(${resourceGrant.subjectType} = 'member' and ${resourceGrant.subjectId} = ${membership.id})
		or (${resourceGrant.subjectType} = 'role' and ${resourceGrant.subjectId} = any(${roleIds}))
	)`

	function grantsWhere(idColumn: PgColumn, effect: "allow" | "deny"): SQL {
		return sql`select 1 from ${resourceGrant}
			where ${resourceGrant.organizationId} = ${membership.organizationId}
				and ${resourceGrant.resourceType} = ${resourceType}
				and ${resourceGrant.permissionKey} = ${permissionKey}
				and ${resourceGrant.effect} = ${effect}
				and ${resourceGrant.resourceId} = ${idColumn}
				and ${subjectMatch}`
	}

	return {
		// A caller whose roles grant the permission and who has no grants written
		// against them at all is the overwhelmingly common case; saying so lets the
		// list run the query it ran before this existed.
		unrestricted: grantedByRole && (await hasNoGrants(membership, resourceType, permissionKey)),
		condition: (idColumn) =>
			mode === "excludeDenied"
				? sql`not exists (${grantsWhere(idColumn, "deny")})`
				: sql`exists (${grantsWhere(idColumn, "allow")}) and not exists (${grantsWhere(idColumn, "deny")})`,
	}
}

/**
 * Whether this workspace has written any grant of this kind at all.
 *
 * One cheap query that lets the common workspace — nobody has ever written a
 * grant — pay nothing for a feature it does not use.
 */
async function hasNoGrants(
	membership: MembershipRow,
	resourceType: GrantableResourceType,
	permissionKey: WorkspacePermissionKey,
): Promise<boolean> {
	return !(await rbacRepository.workspaceHasGrants(
		membership.organizationId,
		resourceType,
		permissionKey,
	))
}
