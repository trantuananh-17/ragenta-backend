import { createOpenAiCompatible } from "./openai"
import { readError } from "./types"
import type { ListedModel, ProviderClient, ProviderCredential } from "./types"

/**
 * OpenRouter: one key in front of every vendor's models.
 *
 * The chat and embeddings routes are OpenAI's verbatim, so the shared adapter
 * covers them. What OpenRouter needs on top is a way to *discover* its
 * catalogue, because it proxies hundreds of models and the list changes weekly —
 * compiling a snapshot into the build would be stale on arrival and, worse,
 * would price customers' turns from numbers nobody checked.
 *
 * Its `/models` endpoint publishes prices, which makes that discovery worth
 * having: the rates come from the vendor that will actually invoice, rather than
 * from a number typed into a source file. RAGFlow's own OpenRouter entry ships
 * `"llm": []` for the same reason, and its config carries no prices at all —
 * it does not bill per token, so it never had to.
 */

interface OpenRouterModel {
	id?: string
	context_length?: number
	architecture?: { output_modalities?: string[]; input_modalities?: string[] }
	/** USD **per token**, as strings. "0.00001" is $10 per million. */
	pricing?: { prompt?: string; completion?: string }
}

/** Nothing is imported above this. A runaway list should fail loudly, not silently fill a table. */
const MAX_IMPORTED = 1_000

function perMillion(value: string | undefined): number {
	const parsed = Number(value)
	// A price that does not parse must not become zero — a model that bills
	// nothing is one customers can run for free. It is dropped instead.
	return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : Number.NaN
}

export const openrouterClient: ProviderClient = {
	...createOpenAiCompatible("openrouter", "https://openrouter.ai/api/v1", {
		// OpenRouter's embeddings route does not document OpenAI's `dimensions`
		// parameter, so it is not sent: models are recorded at their native width
		// and `embedTexts` refuses a vector that is not that width.
		supportsEmbeddingDimensions: false,
	}),

	async listModels(credential: ProviderCredential): Promise<ListedModel[]> {
		const base = (credential.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "")
		const response = await fetch(`${base}/models`, {
			headers: { authorization: `Bearer ${credential.apiKey}` },
		})
		if (!response.ok) throw await readError("openrouter", response)

		const body = (await response.json()) as { data?: OpenRouterModel[] }

		return (body.data ?? []).flatMap<ListedModel>((entry) => {
			if (!entry.id) return []

			// Text in, text out. This is the signal that a model generates rather
			// than embeds; an embedding model advertises no text output, so it is
			// skipped here instead of being imported as a chat model that would
			// then fail on first use.
			const outputs = entry.architecture?.output_modalities ?? []
			if (!outputs.includes("text")) return []

			const inputPerMillion = perMillion(entry.pricing?.prompt)
			const outputPerMillion = perMillion(entry.pricing?.completion)
			if (!Number.isFinite(inputPerMillion) || !Number.isFinite(outputPerMillion)) {
				return []
			}

			return [
				{
					id: entry.id,
					capability: "chat",
					inputPerMillion,
					outputPerMillion,
					embeddingPerMillion: 0,
					contextWindow: entry.context_length,
					// The same field that says what comes out says what may go in,
					// and it is the only trustworthy answer available: OpenRouter
					// proxies hundreds of models under vendor-namespaced ids, so
					// reading vision off the name would be guessing. Getting it
					// wrong here is what produced "No endpoints found that support
					// image input" from the router rather than from us.
					vision: (entry.architecture?.input_modalities ?? []).includes("image"),
				},
			]
		}).slice(0, MAX_IMPORTED)
	},
}
