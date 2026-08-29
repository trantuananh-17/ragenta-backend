import { z } from "zod"

const slugSchema = z
	.string()
	.min(2)
	.max(40)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens.")

export const createProjectSchema = z.object({
	name: z.string().trim().min(2).max(80),
	slug: slugSchema.optional(),
	description: z.string().trim().max(500).optional(),
})

export const updateProjectSchema = z
	.object({
		name: z.string().trim().min(2).max(80).optional(),
		description: z.string().trim().max(500).nullable().optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "Provide at least one field to update.",
	})

export const listProjectsQuerySchema = z.object({
	includeArchived: z
		.enum(["true", "false"])
		.default("false")
		.transform((value) => value === "true"),
})

export type CreateProjectInput = z.infer<typeof createProjectSchema>
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>
