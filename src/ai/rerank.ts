import { ValidationError } from "../shared/errors"
import { findCatalogueModel, requireCredential } from "./catalogue"
import { providerClient } from "./clients"
import { truncateToTokens } from "./tokens"

/**
 * Second-stage ranking.
 *
 * Retrieval scores a question and a passage separately and compares the two
 * numbers; a reranker reads them together and scores the pair. That is a better
 * signal and a much more expensive one, so it runs over the candidates fusion
 * already selected rather than over the corpus — which is exactly where RAGFlow
 * puts its own `rerank_id`.
 *
 * Optional on purpose. Fusion alone answers well, a reranker is a per-query
 * provider call, and a knowledge base that has not chosen one should not pay
 * for one.
 */
export interface RerankModel {
	provider: string
	model: string
}

/** Passages longer than this are cut before being sent; rerankers have small windows. */
const MAX_PASSAGE_TOKENS = 1_024

export interface RerankOutcome {
	/** Input indexes, best first. Shorter than the input when `topN` is smaller. */
	order: Array<{ index: number; score: number }>
	tokens: number
	estimated: boolean
}

export async function resolveRerankModel(
	provider: string,
	model: string,
): Promise<RerankModel> {
	const definition = await findCatalogueModel(provider, model)
	if (!definition) throw new ValidationError(`Unknown model ${provider}/${model}.`)
	if (definition.capability !== "rerank") {
		throw new ValidationError(`${model} is a ${definition.capability} model.`)
	}
	if (!providerClient(provider)?.rerank) {
		throw new ValidationError(`This deployment cannot rerank with ${provider}.`)
	}
	return { provider, model }
}

export async function rerankPassages(
	target: RerankModel,
	query: string,
	passages: string[],
	topN: number,
): Promise<RerankOutcome> {
	if (passages.length === 0) return { order: [], tokens: 0, estimated: false }

	const client = providerClient(target.provider)
	if (!client?.rerank) {
		throw new ValidationError(`This deployment cannot rerank with ${target.provider}.`)
	}

	const credential = await requireCredential(target.provider)
	const result = await client.rerank(credential, {
		model: target.model,
		query,
		documents: passages.map((text) => truncateToTokens(text, MAX_PASSAGE_TOKENS)),
		topN: Math.min(topN, passages.length),
	})

	return {
		// Providers return their results sorted, but nothing in the contract says
		// so, and a wrong order here would be invisible — every passage is real.
		order: [...result.scores].sort((a, b) => b.score - a.score),
		tokens: result.tokens,
		estimated: result.estimated,
	}
}
