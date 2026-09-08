import { z } from "zod"

export const startOAuthSchema = z.object({
	/**
	 * Where to send the browser after the callback. Validated as a path on our own
	 * app in `pkce.ts` — an open redirect here is reached the instant an
	 * authorization succeeds, which is when somebody is most likely to believe a
	 * page that looks like the product.
	 */
	returnTo: z.string().trim().max(500).optional(),
})

export const oauthCallbackSchema = z.object({
	code: z.string().min(1).max(2_000).optional(),
	state: z.string().min(1).max(500).optional(),
	error: z.string().max(200).optional(),
	error_description: z.string().max(500).optional(),
})

export const saveOAuthClientSchema = z.object({
	clientId: z.string().trim().min(1).max(500),
	/** Omitted keeps the stored secret; a form resubmitted without it must not delete one. */
	clientSecret: z.string().trim().min(1).max(500).optional(),
	enabled: z.boolean().default(true),
})

export type SaveOAuthClientInput = z.infer<typeof saveOAuthClientSchema>
