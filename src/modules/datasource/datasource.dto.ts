import { z } from "zod"

/**
 * A query's name is what the model calls it, so it has to survive being part of
 * a tool argument: lower-case, underscores, no spaces.
 */
const queryName = z
	.string()
	.trim()
	.min(2)
	.max(64)
	.regex(/^[a-z][a-z0-9_]*$/, "Use lower-case letters, digits and underscores.")

export const saveDataSourceSchema = z.object({
	id: z.string().min(1).optional(),
	name: z.string().trim().min(1).max(80),
	/**
	 * Omitted keeps the stored connection string — a form resubmitted without the
	 * password must not delete it. The engine is read from the string rather than
	 * chosen, because the scheme already says which it is.
	 */
	dsn: z.string().trim().min(10).max(1_000).optional(),
	enabled: z.boolean().default(true),
})

export const saveQuerySchema = z.object({
	id: z.string().min(1).optional(),
	dataSourceId: z.string().min(1),
	name: queryName,
	description: z.string().trim().min(1).max(500),
	/**
	 * The statement, with placeholders. Never validated by reading it for
	 * dangerous words — that check looks like security and is not (ADR-064). What
	 * holds is the read-only transaction the connection runs in.
	 */
	sql: z.string().trim().min(1).max(4_000),
	parameters: z
		.array(
			z.object({
				name: queryName,
				type: z.enum(["text", "number", "boolean"]),
				description: z.string().trim().max(300).default(""),
			}),
		)
		.max(10)
		.default([]),
	rowLimit: z.number().int().min(1).max(500).default(50),
	origin: z.enum(["manual", "generated"]).default("manual"),
	/**
	 * Only meaningful for a generated query, and only sent by the screen that has
	 * shown somebody the SQL and the rows it returned. A hand-written query is
	 * approved by the act of saving it.
	 */
	approve: z.boolean().optional(),
})

export const generateQuerySchema = z.object({
	dataSourceId: z.string().min(1),
	description: z
		.string()
		.trim()
		.min(5)
		.max(500)
		.describe("What the query should answer, in plain language."),
})

export const dryRunSchema = z.object({
	dataSourceId: z.string().min(1),
	sql: z.string().trim().min(1).max(4_000),
	parameters: z.array(z.unknown()).max(10).default([]),
	rowLimit: z.number().int().min(1).max(100).default(20),
})

export type SaveDataSourceInput = z.infer<typeof saveDataSourceSchema>
export type SaveQueryInput = z.infer<typeof saveQuerySchema>
export type GenerateQueryInput = z.infer<typeof generateQuerySchema>
