import { describe, expect, it } from "vitest"

import { planAllowsModel } from "./entitlement"
import type { PlanModelAccess } from "../provider/provider.service"

/**
 * The rule that decides whether a workspace may spend money on a model.
 *
 * Its two branches fail in opposite and equally quiet ways. Read an empty
 * allowlist as "deny everything" and every plan loses every model at once, with
 * the model picker simply going empty and nothing saying why. Let the allowlist
 * miss and an administrator who restricted the free plan to two cheap models
 * finds it running whatever the tier rule permits, which is the setting they
 * went to the admin console specifically to override.
 *
 * The list is per capability, which is the other thing worth pinning: restricting
 * which chat models the free plan may run must not also restrict its embedding
 * models, or a workspace that can chat can no longer index a document.
 */

const access = (overrides: Partial<PlanModelAccess> = {}): PlanModelAccess => ({
	chat: { allowed: [], default: null },
	embedding: { allowed: [], default: null },
	rerank: { allowed: [] },
	...overrides,
})

const model = (
	provider: string,
	name: string,
	capability: "chat" | "embedding" | "rerank",
	tier: "economy" | "premium",
) => ({ provider, model: name, capability, tier }) as const

const HAIKU = model("anthropic", "claude-haiku-4-5", "chat", "economy")
const SONNET = model("anthropic", "claude-sonnet-5", "chat", "premium")
const EMBEDDING = model("openai", "text-embedding-3-small", "embedding", "economy")

describe("planAllowsModel", () => {
	it("falls back to the plan's tiers when no administrator has said anything", () => {
		// The behaviour every deployment had before the allowlist existed, and the
		// one an empty list has to keep meaning.
		expect(planAllowsModel(access(), "free", HAIKU)).toBe(true)
		expect(planAllowsModel(access(), "free", SONNET)).toBe(false)
		expect(planAllowsModel(access(), "pro", SONNET)).toBe(true)
	})

	it("lets a free workspace embed, so it can index a document at all", () => {
		expect(planAllowsModel(access(), "free", EMBEDDING)).toBe(true)
	})

	it("obeys an allowlist over the plan's tiers", () => {
		const restricted = access({
			chat: { allowed: ["anthropic:claude-haiku-4-5"], default: null },
		})

		expect(planAllowsModel(restricted, "pro", HAIKU)).toBe(true)
		// Pro's tier would allow this. The administrator said otherwise.
		expect(planAllowsModel(restricted, "pro", SONNET)).toBe(false)
	})

	it("lets an allowlist widen a plan as well as narrow it", () => {
		// The point of an allowlist is that it is the answer, not a filter applied
		// after the tier rule — so a premium model can be granted to free.
		const widened = access({
			chat: { allowed: ["anthropic:claude-sonnet-5"], default: null },
		})

		expect(planAllowsModel(widened, "free", SONNET)).toBe(true)
	})

	it("applies an allowlist only to the capability it was written for", () => {
		// Restricting chat must not silently restrict embedding: they are separate
		// lists because a deployment that pins its chat models still wants every
		// embedding model its knowledge bases were built with.
		const chatOnly = access({
			chat: { allowed: ["anthropic:claude-haiku-4-5"], default: null },
		})

		expect(planAllowsModel(chatOnly, "free", SONNET)).toBe(false)
		expect(planAllowsModel(chatOnly, "free", EMBEDDING)).toBe(true)
	})

	it("refuses a model the allowlist does not name", () => {
		const restricted = access({
			chat: { allowed: ["openai:gpt-4o-mini"], default: null },
		})

		expect(planAllowsModel(restricted, "enterprise", HAIKU)).toBe(false)
	})

	it("matches on provider and model together, not on the model name alone", () => {
		// The same model name is served by more than one provider — OpenRouter
		// proxies models the direct providers also sell — and they are separate
		// entries with separate prices.
		const restricted = access({
			chat: { allowed: ["openrouter:anthropic/claude-haiku-4-5"], default: null },
		})

		expect(planAllowsModel(restricted, "pro", HAIKU)).toBe(false)
		expect(
			planAllowsModel(restricted, "pro", model("openrouter", "anthropic/claude-haiku-4-5", "chat", "economy")),
		).toBe(true)
	})

	it("gives an enterprise plan both tiers when nothing is listed", () => {
		expect(planAllowsModel(access(), "enterprise", SONNET)).toBe(true)
		expect(planAllowsModel(access(), "enterprise", HAIKU)).toBe(true)
	})
})
