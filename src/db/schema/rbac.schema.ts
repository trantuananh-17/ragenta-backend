import { relations, sql } from "drizzle-orm"
import {
	boolean,
	check,
	index,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"

import { user } from "./auth.schema"
import { member, organization } from "./workspace.schema"

/**
 * Role-based access control.
 *
 * Before this, authorization was a string comparison against `member.role` in 37
 * route files, and a platform administrator was a boolean. Neither could be
 * changed without a deploy, and neither could express "may read the audit log but
 * may not adjust credits" — which is the first thing anybody asks for.
 *
 * Every relation here is many-to-many on purpose (ADR-046). A membership holds a
 * *set* of roles and a role holds a *set* of permissions, so the next requirement
 * is a row rather than a migration. The one deliberate exception is
 * `member.role`, which stays a single string because Better Auth's organization
 * plugin resolves its own membership operations through it; it is kept in step
 * with the member's primary role and is never read by Ragenta's own checks.
 */

/**
 * The catalogue. Rows are a reconciled copy of
 * `src/auth/permissions/catalogue.ts` — code is the source of truth and the
 * seeder writes it on every migrate, so a permission added in a release reaches
 * the built-in roles without a hand-written INSERT.
 *
 * The key is the primary key rather than a surrogate id: it is stable, it is what
 * every call site names, and it makes `role_permission` readable in psql at three
 * in the morning.
 */
export const permission = pgTable(
	"permission",
	{
		/** `<resource>.<action>`, unique across both scopes. */
		key: text("key").primaryKey(),
		/** workspace | platform */
		scope: text("scope").notNull(),
		resource: text("resource").notNull(),
		action: text("action").notNull(),
		description: text("description").notNull(),
		/**
		 * Set when this permission can also be granted on a single resource through
		 * `resource_grant`: `project`, `knowledgeBase` or `agent`. NULL means it is
		 * only ever answered for the whole workspace.
		 */
		grantableOn: text("grantable_on"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		check("permission_scope_check", sql`${table.scope} in ('workspace', 'platform')`),
		check(
			"permission_grantable_on_check",
			sql`${table.grantableOn} is null or ${table.grantableOn} in ('project', 'knowledgeBase', 'agent')`,
		),
		index("permission_scope_idx").on(table.scope),
	],
)

/**
 * A named set of permissions.
 *
 * `organization_id IS NULL` is a role the platform ships or a platform
 * administrator created; set, it is one workspace's own role and only that
 * workspace may assign it. Same reasoning as `integration` (ADR-042): one table
 * with an owner column, not two tables that drift.
 *
 * `is_system` marks a role the seeder owns. Its permission set is reconciled on
 * every migrate and cannot be edited through the API — otherwise an edit would be
 * silently reverted by the next deploy, which is worse than refusing it.
 */
export const role = pgTable(
	"role",
	{
		id: text("id").primaryKey(),
		/** NULL for a built-in or platform role; set for a workspace's own. */
		organizationId: text("organization_id").references(() => organization.id, {
			onDelete: "cascade",
		}),
		/** workspace | platform. A platform role never carries an organization. */
		scope: text("scope").notNull(),
		/** Stable slug, e.g. `owner`. Unique per owner, not globally. */
		key: text("key").notNull(),
		name: text("name").notNull(),
		description: text("description").default("").notNull(),
		isSystem: boolean("is_system").default(false).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
	},
	(table) => [
		check("role_scope_check", sql`${table.scope} in ('workspace', 'platform')`),
		check(
			"role_platform_has_no_organization_check",
			sql`${table.scope} <> 'platform' or ${table.organizationId} is null`,
		),
		// Two unique indexes rather than one, because in SQL two NULLs are distinct:
		// a single unique on (organization_id, key) would happily accept a second
		// built-in `owner`, which is exactly the row that must never exist twice.
		uniqueIndex("role_workspace_key_uidx")
			.on(table.organizationId, table.key)
			.where(sql`organization_id is not null`),
		uniqueIndex("role_global_key_uidx")
			.on(table.scope, table.key)
			.where(sql`organization_id is null`),
		index("role_organizationId_idx").on(table.organizationId),
	],
)

/** n-n: what a role may do. */
export const rolePermission = pgTable(
	"role_permission",
	{
		roleId: text("role_id")
			.notNull()
			.references(() => role.id, { onDelete: "cascade" }),
		permissionKey: text("permission_key")
			.notNull()
			.references(() => permission.key, { onDelete: "cascade" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.roleId, table.permissionKey] }),
		index("rolePermission_permissionKey_idx").on(table.permissionKey),
	],
)

/**
 * n-n: the roles a membership holds. The effective permission set is the union,
 * so adding a second role can only widen what somebody may do — narrowing is what
 * `resource_grant`'s deny effect is for.
 */
export const memberRole = pgTable(
	"member_role",
	{
		memberId: text("member_id")
			.notNull()
			.references(() => member.id, { onDelete: "cascade" }),
		roleId: text("role_id")
			.notNull()
			.references(() => role.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
	},
	(table) => [
		primaryKey({ columns: [table.memberId, table.roleId] }),
		index("memberRole_roleId_idx").on(table.roleId),
	],
)

/**
 * n-n: platform roles held by a user account.
 *
 * Separate from `member_role` because a platform role is not scoped to a
 * workspace, and joining the two through one table would mean every workspace
 * permission query carried a `WHERE organization_id IS NULL OR = $1` that one
 * forgotten call site could get wrong.
 */
export const userPlatformRole = pgTable(
	"user_platform_role",
	{
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		roleId: text("role_id")
			.notNull()
			.references(() => role.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
	},
	(table) => [
		primaryKey({ columns: [table.userId, table.roleId] }),
		index("userPlatformRole_roleId_idx").on(table.roleId),
	],
)

/**
 * A permission answered for one resource instead of for the whole workspace.
 *
 * This is the layer that makes "everything except the HR knowledge base"
 * expressible. `effect = 'deny'` **wins over everything**, including an allow on
 * the same resource and anything a role granted: a narrowing grant that could be
 * out-voted by adding a role would be a security control that quietly stops
 * working.
 *
 * `subject_id` is polymorphic — a `member.id` or a `role.id` — so it carries no
 * foreign key. The cleanup that a foreign key would have done is done by
 * `organization_id`'s cascade for a deleted workspace, and by the repository when
 * a member or role is removed. `resource_id` is polymorphic for the same reason;
 * a grant naming a deleted resource is inert, because the resource is fetched and
 * scoped before its permission is ever asked.
 */
export const resourceGrant = pgTable(
	"resource_grant",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** member | role */
		subjectType: text("subject_type").notNull(),
		subjectId: text("subject_id").notNull(),
		/** project | knowledgeBase | agent */
		resourceType: text("resource_type").notNull(),
		resourceId: text("resource_id").notNull(),
		permissionKey: text("permission_key")
			.notNull()
			.references(() => permission.key, { onDelete: "cascade" }),
		/** allow | deny — deny wins. */
		effect: text("effect").default("allow").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
	},
	(table) => [
		check("resourceGrant_subjectType_check", sql`${table.subjectType} in ('member', 'role')`),
		check(
			"resourceGrant_resourceType_check",
			sql`${table.resourceType} in ('project', 'knowledgeBase', 'agent')`,
		),
		check("resourceGrant_effect_check", sql`${table.effect} in ('allow', 'deny')`),
		uniqueIndex("resourceGrant_unique_uidx").on(
			table.organizationId,
			table.subjectType,
			table.subjectId,
			table.resourceType,
			table.resourceId,
			table.permissionKey,
		),
		// The shape every resolution reads: one workspace, one resource, all
		// subjects — the subject filter is applied in memory against a set that is
		// already small, because a resource with hundreds of explicit grants is a
		// role waiting to be created.
		index("resourceGrant_lookup_idx").on(
			table.organizationId,
			table.resourceType,
			table.resourceId,
		),
		index("resourceGrant_subject_idx").on(table.subjectType, table.subjectId),
	],
)

export const permissionRelations = relations(permission, ({ many }) => ({
	rolePermissions: many(rolePermission),
}))

export const roleRelations = relations(role, ({ one, many }) => ({
	organization: one(organization, {
		fields: [role.organizationId],
		references: [organization.id],
	}),
	permissions: many(rolePermission),
	memberRoles: many(memberRole),
	userPlatformRoles: many(userPlatformRole),
}))

export const rolePermissionRelations = relations(rolePermission, ({ one }) => ({
	role: one(role, { fields: [rolePermission.roleId], references: [role.id] }),
	permission: one(permission, {
		fields: [rolePermission.permissionKey],
		references: [permission.key],
	}),
}))

export const memberRoleRelations = relations(memberRole, ({ one }) => ({
	member: one(member, { fields: [memberRole.memberId], references: [member.id] }),
	role: one(role, { fields: [memberRole.roleId], references: [role.id] }),
}))

export const userPlatformRoleRelations = relations(userPlatformRole, ({ one }) => ({
	user: one(user, { fields: [userPlatformRole.userId], references: [user.id] }),
	role: one(role, { fields: [userPlatformRole.roleId], references: [role.id] }),
}))

export const resourceGrantRelations = relations(resourceGrant, ({ one }) => ({
	organization: one(organization, {
		fields: [resourceGrant.organizationId],
		references: [organization.id],
	}),
	permission: one(permission, {
		fields: [resourceGrant.permissionKey],
		references: [permission.key],
	}),
}))
