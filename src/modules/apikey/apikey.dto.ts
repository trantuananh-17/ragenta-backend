import { z } from "zod"

import { WORKSPACE_PERMISSION_KEYS } from "../../auth/permissions"

export const createApiKeySchema = z.object({
	name: z.string().trim().min(1).max(80).describe("What this key is for, so it can be revoked."),
	/**
	 * Validated against the catalogue here and against the creator's own set in
	 * the service. Both, because the first is a typo and the second is a
	 * privilege escalation, and they deserve different messages.
	 */
	permissions: z
		.array(z.enum(WORKSPACE_PERMISSION_KEYS as unknown as [string, ...string[]]))
		.min(1)
		.max(60),
	/**
	 * ISO date-time. Optional, and the screen should encourage one: a key with no
	 * expiry is a credential that outlives everybody who remembers what it was for.
	 */
	expiresAt: z.string().datetime().optional(),
})

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>
