import { z } from "zod"

import {
	CUSTOM_TOPUP_MAX_USD,
	CUSTOM_TOPUP_MIN_USD,
	PLAN_NAMES,
	TOPUP_PACKS,
} from "./plans"

const packIds = Object.keys(TOPUP_PACKS) as [string, ...string[]]

/**
 * Exactly one of `plan`, `pack` or `amountUsd` — a checkout is either a
 * subscription or a one-off top-up, and the two use different Stripe modes. A
 * custom amount is the same purchase as a pack, only priced by the dollar, so it
 * belongs on this schema rather than on a second endpoint.
 */
export const createCheckoutSchema = z
	.object({
		plan: z.enum(PLAN_NAMES as [string, ...string[]]).optional(),
		pack: z.enum(packIds).optional(),
		// Whole dollars only: a fractional dollar buys a fractional credit the
		// ledger would have to round away anyway. The bounds are checked before
		// `int` because zod stops at a failed format check, and an amount like 9.99
		// has to be told it is under the minimum rather than only that it has cents.
		amountUsd: z
			.number()
			.min(
				CUSTOM_TOPUP_MIN_USD,
				`A custom top-up must be at least $${CUSTOM_TOPUP_MIN_USD}.`,
			)
			.max(
				CUSTOM_TOPUP_MAX_USD,
				`A custom top-up cannot exceed $${CUSTOM_TOPUP_MAX_USD}. Contact sales for more.`,
			)
			.int("A custom top-up must be a whole number of dollars.")
			.optional(),
	})
	.refine(
		(value) =>
			[value.plan, value.pack, value.amountUsd].filter((field) => field !== undefined)
				.length === 1,
		{
			message: "Provide exactly one of a plan, a top-up pack or a custom amount.",
		},
	)

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
