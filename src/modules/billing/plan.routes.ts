import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import type { AppEnv } from "../../api/types"
import { PLAN_LIMITS, PLAN_NAMES, SIGNUP_GRANT_CREDITS, TOPUP_PACKS } from "./plans"

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
		plans: PLAN_NAMES.map((name) => ({ name, ...PLAN_LIMITS[name] })),
		topupPacks: Object.entries(TOPUP_PACKS).map(([id, pack]) => ({
			id,
			credits: pack.credits,
			priceUsd: pack.priceUsd,
			usdPerMillionCredits:
				Math.round((pack.priceUsd / (pack.credits / 1_000_000)) * 100) / 100,
		})),
	}),
)
