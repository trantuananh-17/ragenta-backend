import { and, eq, isNull, notInArray, sql } from "drizzle-orm"

import {
	PERMISSIONS,
	SYSTEM_ROLES,
	WORKSPACE_SYSTEM_ROLE_KEYS,
	systemRoleId,
} from "../../auth/permissions"
import type { DbExecutor } from "../../db/client"
import { db } from "../../db/client"
import { member, memberRole, permission, role, rolePermission } from "../../db/schema"
import { logger } from "../../shared/logger"

/**
 * Reconciles the database with the permission catalogue in code.
 *
 * Run from the migration step, after the schema is in place and before any
 * process serves a request. It is idempotent by construction — every statement is
 * an upsert or a difference — so running it on every deploy is the point rather
 * than a cost: a permission added in a release reaches the built-in roles without
 * anybody writing an INSERT, and a role screen never shows a permission the code
 * no longer checks.
 *
 * What it deliberately does **not** touch: a role a human created. Those exist to
 * be different from the defaults, and a seeder that "corrected" them would undo
 * somebody's deliberate decision on every deploy, silently.
 */
export async function seedRbac(executor: DbExecutor = db): Promise<void> {
	await executor.transaction(async (tx) => {
		await syncPermissions(tx)
		await syncSystemRoles(tx)
		await backfillMemberRoles(tx)
	})
}

async function syncPermissions(tx: DbExecutor): Promise<void> {
	const keys = PERMISSIONS.map((entry) => entry.key)

	await tx
		.insert(permission)
		.values(
			PERMISSIONS.map((entry) => ({
				key: entry.key,
				scope: entry.scope,
				resource: entry.resource,
				action: entry.action,
				description: entry.description,
				grantableOn: entry.grantableOn ?? null,
			})),
		)
		.onConflictDoUpdate({
			target: permission.key,
			set: {
				scope: sql`excluded.scope`,
				resource: sql`excluded.resource`,
				action: sql`excluded.action`,
				description: sql`excluded.description`,
				grantableOn: sql`excluded.grantable_on`,
			},
		})

	// A permission dropped from the catalogue is no longer checked anywhere, so
	// leaving the row would leave a control on the roles screen that does nothing.
	// The cascade takes it out of every role that referenced it, custom ones
	// included — which is why it is logged rather than done quietly.
	const removed = await tx
		.delete(permission)
		.where(notInArray(permission.key, keys))
		.returning({ key: permission.key })

	if (removed.length > 0) {
		logger.warn("Removed permissions no longer in the catalogue", {
			keys: removed.map((row) => row.key),
		})
	}
}

async function syncSystemRoles(tx: DbExecutor): Promise<void> {
	for (const definition of SYSTEM_ROLES) {
		const id = systemRoleId(definition.scope, definition.key)

		await tx
			.insert(role)
			.values({
				id,
				organizationId: null,
				scope: definition.scope,
				key: definition.key,
				name: definition.name,
				description: definition.description,
				isSystem: true,
			})
			.onConflictDoUpdate({
				target: role.id,
				set: {
					name: sql`excluded.name`,
					description: sql`excluded.description`,
					scope: sql`excluded.scope`,
					isSystem: sql`excluded.is_system`,
				},
			})

		await tx
			.insert(rolePermission)
			.values(definition.permissions.map((key) => ({ roleId: id, permissionKey: key })))
			.onConflictDoNothing()

		// A permission taken off a built-in role in code has to come off the role in
		// the database too, or the role keeps a power the release intended to remove.
		await tx
			.delete(rolePermission)
			.where(
				and(
					eq(rolePermission.roleId, id),
					notInArray(rolePermission.permissionKey, [...definition.permissions]),
				),
			)
	}
}

/**
 * Gives every existing membership the system role its `member.role` string names.
 *
 * This is what makes the cutover invisible: before this ran, authorization read
 * `member.role`; after it, authorization reads the union of a membership's roles,
 * and for everybody who existed already those are the same set.
 *
 * A membership whose `role` string is not one Ragenta ships — Better Auth accepts
 * arbitrary strings and a comma list — gets `member`, the least-privileged role
 * that can still use the product. Guessing upward would hand somebody access
 * nobody granted.
 */
async function backfillMemberRoles(tx: DbExecutor): Promise<void> {
	const withoutRoles = await tx
		.select({ id: member.id, role: member.role })
		.from(member)
		.where(
			sql`not exists (select 1 from ${memberRole} where ${memberRole.memberId} = ${member.id})`,
		)

	if (withoutRoles.length === 0) return

	const rows = withoutRoles.map((row) => {
		const primary = row.role.split(",")[0]?.trim() ?? ""
		const key = (WORKSPACE_SYSTEM_ROLE_KEYS as string[]).includes(primary) ? primary : "member"
		return { memberId: row.id, roleId: systemRoleId("workspace", key) }
	})

	await tx.insert(memberRole).values(rows).onConflictDoNothing()

	logger.info("Backfilled workspace roles onto existing memberships", { count: rows.length })
}

/** Deletes system roles the catalogue no longer defines. Called by the seeder's caller. */
export async function pruneSystemRoles(executor: DbExecutor = db): Promise<void> {
	const known = SYSTEM_ROLES.map((definition) => systemRoleId(definition.scope, definition.key))

	const removed = await executor
		.delete(role)
		.where(and(eq(role.isSystem, true), isNull(role.organizationId), notInArray(role.id, known)))
		.returning({ id: role.id })

	if (removed.length > 0) {
		logger.warn("Removed system roles no longer in the catalogue", {
			ids: removed.map((row) => row.id),
		})
	}
}

/** Exported for the migration runner, which wants both in one place. */
export async function reconcileRbac(executor: DbExecutor = db): Promise<void> {
	await seedRbac(executor)
	await pruneSystemRoles(executor)
}

export const rbacSeed = { seedRbac, pruneSystemRoles, reconcileRbac }
