import { afterEach, describe, expect, it, vi } from "vitest"

import { openrouterClient } from "./openrouter"

/**
 * What the OpenRouter import decides about each model it reads.
 *
 * Worth a test because getting `vision` wrong here is invisible from every
 * side. The import succeeds, the rows look right, the model list renders, and
 * the failure only surfaces much later as the router refusing a picture with
 * "No endpoints found that support image input" — an error naming a routing
 * step nobody here wrote, on a model the console said was fine.
 *
 * `fetch` is stubbed rather than the mapping being exported, matching
 * `multimodal.test.ts`: what ships is `listModels`, so that is what is asserted.
 */

function stubModels(data: unknown[]): void {
	vi.stubGlobal("fetch", async () =>
		Response.json({ data }, { status: 200, headers: { "content-type": "application/json" } }),
	)
}

function priced(overrides: Record<string, unknown>) {
	return {
		id: "vendor/model",
		context_length: 128_000,
		architecture: { output_modalities: ["text"], input_modalities: ["text"] },
		pricing: { prompt: "0.000001", completion: "0.000002" },
		...overrides,
	}
}

const credential = { apiKey: "or-test-key" }

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("openrouter listModels", () => {
	it("marks a model that accepts images", async () => {
		stubModels([
			priced({
				architecture: { output_modalities: ["text"], input_modalities: ["text", "image"] },
			}),
		])

		const [model] = await openrouterClient.listModels!(credential)

		expect(model?.vision).toBe(true)
	})

	it("marks a text-only model as not seeing", async () => {
		stubModels([priced({})])

		const [model] = await openrouterClient.listModels!(credential)

		expect(model?.vision).toBe(false)
	})

	/*
		A listing that omits `architecture` entirely is not a listing saying the
		model is blind, and the difference matters downstream: the column this
		lands in is nullable so that "unstated" can fall back to the compiled
		definition. False is still the resolved answer here — there is nothing
		else to go on — but it must come from reading the field, not from the
		field being absent going unnoticed.
	*/
	it("does not claim vision for a model that publishes no modalities", async () => {
		stubModels([priced({ architecture: { output_modalities: ["text"] } })])

		const [model] = await openrouterClient.listModels!(credential)

		expect(model?.vision).toBe(false)
	})

	it("keeps prices and context alongside the flag", async () => {
		stubModels([
			priced({
				id: "anthropic/claude-sonnet-5",
				architecture: { output_modalities: ["text"], input_modalities: ["text", "image"] },
			}),
		])

		const [model] = await openrouterClient.listModels!(credential)

		expect(model).toMatchObject({
			id: "anthropic/claude-sonnet-5",
			capability: "chat",
			contextWindow: 128_000,
			inputPerMillion: 1,
			outputPerMillion: 2,
			vision: true,
		})
	})

	it("skips a model that emits no text, whatever it accepts", async () => {
		stubModels([
			priced({
				architecture: {
					output_modalities: ["image"],
					input_modalities: ["text", "image"],
				},
			}),
		])

		expect(await openrouterClient.listModels!(credential)).toEqual([])
	})
})
