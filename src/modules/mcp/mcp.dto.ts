import { z } from "zod"

/**
 * The slug is part of a tool name the model sees, so it has to survive being an
 * identifier every provider accepts: lower-case, dash-separated, short.
 */
const slugSchema = z
	.string()
	.trim()
	.min(2)
	.max(48)
	.regex(/^[a-z][a-z0-9-]*$/, "Use lower-case letters, digits and dashes.")

/**
 * `http` is accepted as well as `https` because a self-hosted server on the
 * deployment's own network is a real case. What makes that safe is not the
 * scheme — it is `safe-fetch.ts`, which refuses private and link-local addresses
 * on every hop, and the network the container sits on.
 */
const urlSchema = z
	.string()
	.trim()
	.url()
	.max(500)
	.refine(
		(value) => value.startsWith("http://") || value.startsWith("https://"),
		"An MCP server must be reachable over http or https.",
	)

export const saveMcpServerSchema = z.object({
	slug: slugSchema,
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).default(""),
	url: urlSchema,
	enabled: z.boolean().default(true),
	/**
	 * Omitted leaves whatever is stored; `null` clears it. Absent and null are
	 * different on purpose — a form that resubmits without the secret must not
	 * silently delete it, and there has to be a way to say "no credential".
	 */
	secret: z.string().trim().min(1).max(4_000).nullable().optional(),
	authHeader: z.string().trim().min(1).max(64).default("Authorization"),
	authPrefix: z.string().max(32).default("Bearer "),
	/**
	 * Which of the server's tools may be called. Empty accepts everything the
	 * server advertises, now and later — which is a decision, not a default, so
	 * the screen has to show it as one.
	 */
	allowedTools: z.array(z.string().trim().min(1).max(128)).max(200).default([]),
})

export type SaveMcpServerInput = z.infer<typeof saveMcpServerSchema>
