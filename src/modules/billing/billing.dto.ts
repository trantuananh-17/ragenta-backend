import { z } from "zod"

import { PLAN_NAMES, TOPUP_PACKS } from "./plans"

const packIds = Object.keys(TOPUP_PACKS) as [string, ...string[]]

/**
 * Exactly one of `plan` or `pack` — a checkout is either a subscription or a
 * one-off top-up, and the two use different Stripe modes.
 */
export const createCheckoutSchema = z
	.object({
		plan: z.enum(PLAN_NAMES as [string, ...string[]]).optional(),
		pack: z.enum(packIds).optional(),
	})
	.refine((value) => Boolean(value.plan) !== Boolean(value.pack), {
		message: "Provide either a plan or a top-up pack, not both.",
	})

export const updateAutoReloadSchema = z
	.object({
		enabled: z.boolean(),
		thresholdCredits: z.number().int().positive().optional(),
		pack: z.enum(packIds).optional(),
	})
	.refine((value) => !value.enabled || (value.thresholdCredits !== undefined && value.pack), {
		message: "Enabling auto-reload requires a threshold and a pack.",
	})

export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>
export type UpdateAutoReloadInput = z.infer<typeof updateAutoReloadSchema>
