import { z } from "zod"

/** Slugs appear in URLs and must stay stable and unambiguous. */
const slugSchema = z
	.string()
	.min(3)
	.max(40)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens.")

export const createWorkspaceSchema = z.object({
	name: z.string().trim().min(2).max(80),
	slug: slugSchema.optional(),
})

export const updateWorkspaceSchema = z
	.object({
		name: z.string().trim().min(2).max(80).optional(),
		logo: z.url().nullable().optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "Provide at least one field to update.",
	})

/**
 * `owner` is missing on purpose: ownership transfer is its own operation with
 * its own guard, not a role edit.
 */
export const assignableRoleSchema = z.enum(["admin", "member", "viewer"])

export const inviteMemberSchema = z.object({
	email: z.email(),
	role: assignableRoleSchema.default("member"),
})

export const updateMemberRoleSchema = z.object({
	role: assignableRoleSchema,
})

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>
