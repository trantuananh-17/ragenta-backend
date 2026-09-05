import { z } from "zod"

/**
 * Codes are typed by hand off a slide or an email, so they are normalised to
 * upper case on the way in and matched exactly on the way out. Allowing an
 * arbitrary case would mean either a case-insensitive unique index or two codes
 * that look identical in a list.
 */
export const promoCodeValueSchema = z
	.string()
	.trim()
	.min(3)
	.max(48)
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9-]*$/,
		"Use letters, digits and hyphens, starting with a letter or digit.",
	)
	.transform((value) => value.toUpperCase())

/**
 * Expiry is given either as a number of days from now or as an absolute
 * instant, never both — the admin console offers the two as a radio pair and
 * this is the same choice on the wire.
 */
export const createPromoCodeSchema = z
	.object({
		code: promoCodeValueSchema,
		credits: z.number().int().positive().max(1_000_000_000),
		bucket: z.enum(["plan", "topup"]).default("topup"),
		expiresInDays: z.number().int().positive().max(3650).optional(),
		expiresAt: z.iso.datetime().optional(),
		maxRedemptions: z.number().int().positive().max(1_000_000).nullable().default(null),
	})
	.refine(
		(value) => (value.expiresInDays === undefined) !== (value.expiresAt === undefined),
		{ message: "Provide exactly one of expiresInDays or expiresAt." },
	)

/** `active` is the only mutable field: everything else is what people were told. */
export const updatePromoCodeSchema = z.object({
	active: z.boolean(),
})

export const redeemPromoCodeSchema = z.object({
	code: promoCodeValueSchema,
})

export const listPromoCodesQuerySchema = z.object({
	search: z.string().trim().min(1).max(64).optional(),
})

export type CreatePromoCodeInput = z.infer<typeof createPromoCodeSchema>
export type UpdatePromoCodeInput = z.infer<typeof updatePromoCodeSchema>
