import { findCatalogueModel, requireCredential } from "./catalogue"
import { providerClient } from "./clients"
import { estimateTokens, truncateToTokens } from "./tokens"
import { ValidationError } from "../shared/errors"

/**
 * Turning text into vectors, once, for both halves of the system that need it —
 * indexing a document and embedding a question.
 *
 * Batched because the per-request latency dominates: a 400-chunk document is
 * four calls at 100 inputs each, not 400 calls. The batch size is a provider
 * limit, not a tuning knob — OpenAI caps an embeddings request at 2048 inputs
 * and roughly 300k tokens, and 100 stays comfortably inside both while keeping
 * a single failure cheap to retry.
 */
const BATCH_SIZE = 100

/**
 * Inputs longer than this are cut before being sent. An embedding model refuses
 * anything over its own context, and losing the tail of one oversized chunk is
 * better than failing the whole document — the chunker should have prevented it
 * reaching here at all.
 */
const MAX_INPUT_TOKENS = 8_000

export interface EmbeddingModel {
	provider: string
	model: string
	dimensions: number
}

export interface EmbedOutcome {
	vectors: number[][]
	/**
	 * Tokens to bill. The provider's own count where it reports one; the local
	 * estimate where it does not (Gemini's embedding endpoint returns none), in
	 * which case the charge is approximate and knowingly so.
	 */
	embeddingTokens: number
	estimated: boolean
}

/**
 * Resolves a selection to a usable embedding model, or explains why it is not
 * one. Called before indexing rather than during it: discovering the model has
 * no adapter after 300 chunks are written is a half-indexed document.
 */
export async function resolveEmbeddingModel(
	provider: string,
	model: string,
): Promise<EmbeddingModel> {
	const definition = await findCatalogueModel(provider, model)
	if (!definition) {
		throw new ValidationError(`Unknown model ${provider}/${model}.`)
	}
	if (definition.capability !== "embedding") {
		throw new ValidationError(`${model} is a ${definition.capability} model.`)
	}
	if (!definition.embeddingDimensions) {
		throw new ValidationError(
			`${model} has no vector width recorded, so its vectors cannot be indexed.`,
		)
	}

	const client = providerClient(provider)
	if (!client?.embed) {
		throw new ValidationError(
			`This deployment cannot generate embeddings with ${provider}.`,
		)
	}

	return { provider, model, dimensions: definition.embeddingDimensions }
}

export async function embedTexts(
	target: EmbeddingModel,
	texts: string[],
): Promise<EmbedOutcome> {
	if (texts.length === 0) return { vectors: [], embeddingTokens: 0, estimated: false }

	const client = providerClient(target.provider)
	if (!client?.embed) {
		throw new ValidationError(
			`This deployment cannot generate embeddings with ${target.provider}.`,
		)
	}

	const credential = await requireCredential(target.provider)
	const inputs = texts.map((text) => truncateToTokens(text, MAX_INPUT_TOKENS))

	const vectors: number[][] = []
	let reportedTokens = 0

	for (let offset = 0; offset < inputs.length; offset += BATCH_SIZE) {
		const batch = inputs.slice(offset, offset + BATCH_SIZE)
		const result = await client.embed(credential, {
			model: target.model,
			input: batch,
			dimensions: target.dimensions,
		})

		// A vector of the wrong width would be rejected by Qdrant with a message
		// about the collection, several layers from the cause. Catch it here,
		// where the model that produced it is still in hand.
		for (const vector of result.vectors) {
			if (vector.length !== target.dimensions) {
				throw new ValidationError(
					`${target.model} returned ${vector.length}-dimension vectors but is recorded as ${target.dimensions}.`,
				)
			}
		}

		vectors.push(...result.vectors)
		reportedTokens += result.embeddingTokens
	}

	if (reportedTokens > 0) {
		return { vectors, embeddingTokens: reportedTokens, estimated: false }
	}

	return {
		vectors,
		embeddingTokens: inputs.reduce((total, text) => total + estimateTokens(text), 0),
		estimated: true,
	}
}
