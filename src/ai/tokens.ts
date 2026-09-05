/**
 * Token estimation.
 *
 * Deliberately an estimate, and deliberately not tiktoken. Nothing here is ever
 * billed from — every charge comes from the token counts the provider reports
 * after the call (`usageService.recordAndCharge`), because those are the numbers
 * the invoice will use. What this is for is *sizing*: how big to make a chunk,
 * how many chunks fit in a context window, when to stop adding history to a
 * prompt. Being 15% out on those costs nothing; carrying a 2 MB encoding table
 * and a per-model tokenizer to be exact would.
 *
 * The ratio is ~4 characters per token for English and ~2 for CJK, which is
 * roughly what BPE tokenizers do in practice. Vietnamese sits near the English
 * end because it is Latin script, diacritics notwithstanding.
 */
const CJK = /[　-鿿가-힯＀-￯]/

const CHARS_PER_TOKEN_LATIN = 4
const CHARS_PER_TOKEN_CJK = 2

export function estimateTokens(text: string): number {
	if (!text) return 0

	let cjk = 0
	for (const character of text) {
		if (CJK.test(character)) cjk += 1
	}
	const latin = text.length - cjk

	return Math.ceil(latin / CHARS_PER_TOKEN_LATIN + cjk / CHARS_PER_TOKEN_CJK)
}

/** Cuts text to roughly a token budget, on a whitespace boundary where one is near. */
export function truncateToTokens(text: string, maxTokens: number): string {
	if (estimateTokens(text) <= maxTokens) return text

	const limit = maxTokens * CHARS_PER_TOKEN_LATIN
	const cut = text.slice(0, limit)
	const boundary = cut.lastIndexOf(" ")
	return boundary > limit * 0.8 ? cut.slice(0, boundary) : cut
}
