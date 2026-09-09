import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import type { AppEnv } from "../../api/types"
import {
	CUSTOM_TOPUP_MAX_USD,
	CUSTOM_TOPUP_MIN_USD,
	CUSTOM_TOPUP_USD_PER_MILLION_CREDITS,
	PLAN_LIMITS,
	PLAN_NAMES,
	SIGNUP_GRANT_CREDITS,
	TOPUP_PACKS,
} from "./plans"

/**
 * The price list, served from the same constants the server enforces. Billing
 * screens and upgrade dialogs read this instead of hardcoding numbers that then
 * drift away from what the seat cap and refill job actually do.
 */
export const planRoutes = new Hono<AppEnv>()

planRoutes.use("*", requireAuth)

planRoutes.get("/", (c) =>
	c.json({
		signupGrantCredits: SIGNUP_GRANT_CREDITS,
		/**
		 * Free has no monthly allowance any more — the signup grant is the whole of
		 * it. Kept as a literal 0 because this response shape is a contract with
		 * the customer and admin frontends, which both still read the field; drop
		 * it here only once both have stopped.
		 */
		freeMonthlyCredits: 0,
		plans: PLAN_NAMES.map((name) => ({ name, ...PLAN_LIMITS[name] })),
		topupPacks: Object.entries(TOPUP_PACKS).map(([id, pack]) => ({
			id,
			credits: pack.credits,
			priceUsd: pack.priceUsd,
			usdPerMillionCredits:
				Math.round((pack.priceUsd / (pack.credits / 1_000_000)) * 100) / 100,
		})),
		/**
		 * The bounds of a named amount, served for the same reason the packs are:
		 * the screen shows what an amount buys before it is submitted, and it must
		 * quote the rate the checkout will actually charge.
		 */
		customTopup: {
			minUsd: CUSTOM_TOPUP_MIN_USD,
			maxUsd: CUSTOM_TOPUP_MAX_USD,
			usdPerMillionCredits: CUSTOM_TOPUP_USD_PER_MILLION_CREDITS,
		},
	}),
)
