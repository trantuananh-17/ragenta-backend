import { z } from "zod"

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const

/**
 * What an administrator configures for one outside system.
 *
 * The allowlists are ordinary fields here and hard limits at the point of use —
 * an agent cannot widen them, because they are read from this row and never from
 * the request or the model (`.claude/rules/security.md`).
 */
export const saveIntegrationSchema = z.object({
	kind: z.enum(["web_search", "http_api", "email"]),
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).nullable().default(null),
	enabled: z.boolean().default(true),
	/** Required for `http_api`. The others have a fixed host. */
	baseUrl: z.string().trim().url().max(500).nullable().default(null),
	/**
	 * Write-only. Absent leaves whatever is stored alone, so editing an
	 * allowlist does not require re-typing a key nobody can read back.
	 */
	secret: z.string().trim().min(1).max(500).optional(),
	authHeader: z.string().trim().max(100).nullable().default(null),
	authPrefix: z.string().max(40).default(""),
	allowedMethods: z.array(z.enum(METHODS)).max(5).default(["GET"]),
	allowedPathPrefix: z.string().trim().max(200).default(""),
	/** Exact addresses, or `*@domain`. A bare `*` is deliberately not accepted. */
	allowedRecipients: z
		.array(z.string().trim().min(3).max(200))
		.max(50)
		.default([])
		.refine((entries) => entries.every((entry) => entry !== "*"), {
			message: "`*` is not an allowed recipient rule. Use `*@yourdomain.com`.",
		}),
})

export type SaveIntegrationInput = z.infer<typeof saveIntegrationSchema>
