import { z } from "zod"

import { PLAN_NAMES } from "../billing/plans"

export const adminListQuerySchema = z.object({
	search: z.string().trim().min(1).max(120).optional(),
})

export const adjustCreditsSchema = z.object({
	/** Positive grants credit, negative claws it back. Never zero. */
	amount: z.number().refine((value) => value !== 0, "Amount must not be zero."),
	bucket: z.enum(["plan", "topup"]).default("topup"),
	reason: z.string().trim().min(3).max(280),
	/**
	 * Optional caller-supplied idempotency key. Retrying the same adjustment with
	 * the same key is a no-op instead of a second movement of credit.
	 */
	idempotencyKey: z.string().trim().min(8).max(120).optional(),
})

export const setPlanSchema = z.object({
	plan: z.enum(PLAN_NAMES as [string, ...string[]]),
})

export type AdjustCreditsInput = z.infer<typeof adjustCreditsSchema>
