import { describe, expect, it } from "vitest"

import { MODELS, tierFor } from "./models"

/**
 * `tierFor` is how an imported model gets a plan tier. OpenRouter publishes
 * hundreds of models with prices and no idea how Ragenta's plans are drawn, so
 * every one of those rows is classified by this function and by nothing else —
 * and the tier is what decides whether a free workspace may spend on it.
 *
 * Getting it wrong in one direction is a support ticket; in the other it is an
 * expensive model made available to a plan that does not pay for it, which is
 * discovered from the provider's invoice. The ceilings are documented as chosen
 * to reproduce the hand-written catalogue rather than invented, so that claim is
 * what the first test checks — against the catalogue itself, so a model added
 * with a tier that its own prices contradict fails here.
 */

describe("tierFor", () => {
	it("reproduces the tier every built-in chat and embedding model declares", () => {
		// Rerank models are excluded on purpose: nothing imports one, so `tierFor`
		// is never asked about them, and the one in the catalogue is deliberately
		// economy at a price this function would call premium. See the note in the
		// report that came with these tests.
		const classified = MODELS.filter((model) => model.capability !== "rerank")

		expect(classified.length).toBeGreaterThan(0)
		for (const model of classified) {
			expect({
				model: `${model.provider}/${model.model}`,
				tier: tierFor(model.rates.input, model.rates.output),
			}).toEqual({ model: `${model.provider}/${model.model}`, tier: model.tier })
		}
	})

	it("calls a model economy when it is under both ceilings", () => {
		// gpt-4o-mini's and gemini-2.5-flash's real rates.
		expect(tierFor(0.15, 0.6)).toBe("economy")
		expect(tierFor(0.3, 2.5)).toBe("economy")
	})

	it("includes a model priced exactly at both ceilings", () => {
		// The comparison is inclusive, so a vendor pricing a model exactly on the
		// line lands in the cheaper tier rather than one cent's worth of rounding
		// deciding which plans may run it.
		expect(tierFor(0.5, 3)).toBe("economy")
	})

	it("calls a model premium when either price alone is over its ceiling", () => {
		// Both directions, because a model can be cheap to prompt and expensive to
		// read back — which is the shape most reasoning models have.
		expect(tierFor(0.51, 3)).toBe("premium")
		expect(tierFor(0.5, 3.01)).toBe("premium")
		expect(tierFor(3, 15)).toBe("premium")
	})

	it("keeps the models the lowered ceilings were meant to move out of economy", () => {
		// The 1 / 5 ceilings put Haiku and gemini-3.7-flash beside gpt-4o-mini at
		// roughly seven times its blended price. Both are premium now, and these
		// are the real rates that must keep them there.
		expect(tierFor(1, 5)).toBe("premium")
		expect(tierFor(0.75, 3.75)).toBe("premium")
	})

	it("calls a free model economy", () => {
		// A zero-priced model on OpenRouter is real, and it must not land in
		// premium and be refused to the plan that could most use it.
		expect(tierFor(0, 0)).toBe("economy")
	})
})
