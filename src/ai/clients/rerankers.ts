import { estimateTokens } from "../tokens"
import { readError } from "./types"
import type {
	CheckResult,
	ProviderClient,
	ProviderCredential,
	RerankRequest,
	RerankResult,
} from "./types"

/**
 * The rerank-only providers.
 *
 * A reranker is a cross-encoder: it reads the question and one passage
 * *together* and scores the pair, where retrieval scores each independently.
 * That is strictly more informative and strictly more expensive, which is why
 * it runs over the ~30 candidates fusion produced rather than over the corpus.
 * RAGFlow makes the same trade with `rerank_id` on its assistant.
 *
 * All three publish nearly the same contract — `{query, documents, top_n}` in,
 * `{results: [{index, relevance_score}]}` out — so one adapter covers them and
 * the differences are the base URL, the path, and Cohere's insistence on
 * `top_n` being present. Where they genuinely diverge is billing: none reports
 * token usage, because they price per search, so the charge is estimated from
 * the text sent and `estimated` says so on every row.
 */
interface RerankerSpec {
	id: string
	defaultBaseUrl: string
	path: string
	/** Cheap authenticated call for the connection check. */
	checkModel: string
}

interface RerankResponse {
	results?: Array<{ index?: number; relevance_score?: number; score?: number }>
	data?: Array<{ index?: number; relevance_score?: number; score?: number }>
	usage?: { total_tokens?: number }
	meta?: { billed_units?: { search_units?: number } }
}

function createReranker(spec: RerankerSpec): ProviderClient {
	async function call(
		credential: ProviderCredential,
		request: RerankRequest,
	): Promise<RerankResult> {
		const base = credential.baseUrl?.replace(/\/+$/, "") ?? spec.defaultBaseUrl

		const response = await fetch(`${base}${spec.path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${credential.apiKey}`,
			},
			body: JSON.stringify({
				model: request.model,
				query: request.query,
				documents: request.documents,
				top_n: request.topN,
			}),
			signal: request.signal,
		})

		if (!response.ok) throw await readError(spec.id, response)

		const body = (await response.json()) as RerankResponse
		const results = body.results ?? body.data ?? []

		const scores = results.flatMap((entry) => {
			const index = entry.index
			const score = entry.relevance_score ?? entry.score
			if (typeof index !== "number" || typeof score !== "number") return []
			// A provider that returned an index outside the batch would silently
			// reorder someone else's passages into this answer.
			if (index < 0 || index >= request.documents.length) return []
			return [{ index, score }]
		})

		const reported = body.usage?.total_tokens ?? 0
		if (reported > 0) return { scores, tokens: reported, estimated: false }

		return {
			scores,
			tokens:
				estimateTokens(request.query) * request.documents.length +
				request.documents.reduce((total, text) => total + estimateTokens(text), 0),
			estimated: true,
		}
	}

	return {
		id: spec.id,
		defaultBaseUrl: spec.defaultBaseUrl,
		rerank: call,
		async check(credential: ProviderCredential): Promise<CheckResult> {
			// A real rerank of two short passages: there is no model-list endpoint
			// common to the three, and a scoring call is what actually has to work.
			const result = await call(credential, {
				model: spec.checkModel,
				query: "ragenta connection check",
				documents: ["first passage", "second passage"],
				topN: 1,
			})
			return {
				ok: result.scores.length > 0,
				detail:
					result.scores.length > 0
						? `Reranked a two-passage query with ${spec.checkModel}.`
						: `${spec.id} accepted the request but returned no scores.`,
			}
		},
	}
}

export const cohereClient = createReranker({
	id: "cohere",
	defaultBaseUrl: "https://api.cohere.com",
	path: "/v2/rerank",
	checkModel: "rerank-v3.5",
})

export const voyageClient = createReranker({
	id: "voyage",
	defaultBaseUrl: "https://api.voyageai.com",
	path: "/v1/rerank",
	checkModel: "rerank-2.5",
})

export const jinaClient = createReranker({
	id: "jina",
	defaultBaseUrl: "https://api.jina.ai",
	path: "/v1/rerank",
	checkModel: "jina-reranker-v2-base-multilingual",
})
