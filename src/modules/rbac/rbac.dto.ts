import { z } from "zod"

import { PERMISSIONS } from "../../auth/permissions"

const permissionKeys = PERMISSIONS.map((entry) => entry.key)

/**
 * A permission key is validated against the catalogue, not against a pattern.
 * A role holding a key nothing checks is a control on a screen that does
 * nothing, and the wrong moment to discover that is when somebody relies on it.
 */
const permissionKeySchema = z
	.string()
	.refine((key) => permissionKeys.includes(key), "Unknown permission.")

const roleKeySchema = z
	.string()
	.trim()
	.min(2)
	.max(48)
	// Lower-case, dash-separated. The key appears in URLs and in `member.role`,
	// which Better Auth compares as a plain string.
	.regex(/^[a-z][a-z0-9-]*$/, "Use lower-case letters, digits and dashes.")

export const createRoleSchema = z.object({
	key: roleKeySchema,
	name: z.string().trim().min(2).max(80),
	description: z.string().trim().max(280).default(""),
	scope: z.enum(["workspace", "platform"]),
	/**
	 * Which workspace owns this role. Omitted means the platform owns it and
	 * every workspace may assign it — the wider of the two, so it is never the
	 * default of a missing field by accident: `scope: "platform"` refuses an
	 * `organizationId` outright.
	 */
	organizationId: z.string().trim().min(1).optional(),
	permissions: z.array(permissionKeySchema).default([]),
})

export const updateRoleSchema = z
	.object({
		name: z.string().trim().min(2).max(80).optional(),
		description: z.string().trim().max(280).optional(),
		permissions: z.array(permissionKeySchema).optional(),
	})
	.refine(
		(value) => Object.keys(value).length > 0,
		"Nothing to change.",
	)

/**
 * A workspace composing its own role. No `scope` and no `organizationId`: the
 * scope is always `workspace` and the owner comes from the proven membership,
 * never from the body — a field the client supplies is a field the client can
 * change.
 */
export const createWorkspaceRoleSchema = z.object({
	key: roleKeySchema,
	name: z.string().trim().min(2).max(80),
	description: z.string().trim().max(280).default(""),
	permissions: z.array(permissionKeySchema).default([]),
})

export const setRolesSchema = z.object({
	roleIds: z.array(z.string().trim().min(1)).max(16),
})

export const listRolesQuerySchema = z.object({
	workspaceId: z.string().trim().min(1).optional(),
})

export type CreateRoleInput = z.infer<typeof createRoleSchema>
export type CreateWorkspaceRoleInput = z.infer<typeof createWorkspaceRoleSchema>
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>
export type SetRolesInput = z.infer<typeof setRolesSchema>
