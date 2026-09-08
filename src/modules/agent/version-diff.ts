/**
 * What changed between two versions of an agent.
 *
 * `agent_version` has been immutable since ADR-029, so the history has always
 * been there — what was missing is any way to read it. "Version 7 started
 * hallucinating" is unanswerable when the only thing on screen is a list of
 * version numbers, and the answer is almost always one field somebody changed
 * without thinking of it as a change.
 *
 * Pure, and its own module, so it can be tested without a database — the same
 * reason `grant-decision.ts` and `widget-guard.ts` are separate.
 */

/** How a field is shown, which decides how the screen renders the change. */
export type FieldKind = "text" | "value" | "list"

export interface FieldChange {
	field: string
	/** The name somebody sees, matching the label on the configuration form. */
	label: string
	kind: FieldKind
	before: unknown
	after: unknown
}

interface FieldSpec {
	field: string
	label: string
	kind: FieldKind
}

/**
 * The fields compared, in the order the configuration form shows them.
 *
 * A list rather than "every key on the row" on purpose: `id`, `createdAt` and
 * `createdBy` differ between any two versions and mean nothing, so a diff that
 * included them would bury the one line somebody is looking for under three that
 * are true of every pair.
 */
const FIELDS: readonly FieldSpec[] = [
	{ field: "instructions", label: "Instructions", kind: "text" },
	{ field: "provider", label: "Provider", kind: "value" },
	{ field: "model", label: "Model", kind: "value" },
	{ field: "temperature", label: "Temperature", kind: "value" },
	{ field: "maxOutputTokens", label: "Max output tokens", kind: "value" },
	{ field: "knowledgeBaseIds", label: "Knowledge bases", kind: "list" },
	{ field: "searchMode", label: "Search mode", kind: "value" },
	{ field: "topK", label: "Passages", kind: "value" },
	{ field: "similarityThreshold", label: "Similarity threshold", kind: "value" },
	{ field: "vectorWeight", label: "Vector weight", kind: "value" },
	{ field: "rerankProvider", label: "Rerank provider", kind: "value" },
	{ field: "rerankModel", label: "Rerank model", kind: "value" },
	{ field: "groundedOnly", label: "Answer only from documents", kind: "value" },
	{ field: "tools", label: "Tools", kind: "list" },
	{ field: "maxRounds", label: "Maximum rounds", kind: "value" },
	{ field: "creditCeiling", label: "Credit ceiling per run", kind: "value" },
	{ field: "approveWrites", label: "Ask before it changes anything", kind: "value" },
	{ field: "memoryEnabled", label: "Remember between runs", kind: "value" },
	{ field: "memoryScope", label: "Whose memories", kind: "value" },
	{ field: "memoryTopK", label: "Memories recalled per run", kind: "value" },
	{ field: "graph", label: "Flow", kind: "value" },
]

/**
 * Whether two stored values are the same.
 *
 * Numeric columns arrive from Postgres as **strings**, so `0.7` and `"0.70"` are
 * the same temperature written two ways and comparing them with `!==` would
 * report a change nobody made. Lists are compared as sets, because the order of
 * `tools` and `knowledgeBaseIds` is not meaningful and reordering them is not an
 * edit worth telling somebody about.
 */
function unchanged(kind: FieldKind, before: unknown, after: unknown): boolean {
	if (before === after) return true
	if (before === null || before === undefined) return after === null || after === undefined
	if (after === null || after === undefined) return false

	if (kind === "list") {
		if (!Array.isArray(before) || !Array.isArray(after)) return false
		if (before.length !== after.length) return false
		const left = new Set(before.map(String))
		return after.every((entry) => left.has(String(entry)))
	}

	// Numbers that arrived as strings, and strings that happen to look numeric.
	// `Number("")` is 0, so an empty string is excluded rather than compared.
	if (
		(typeof before === "string" || typeof before === "number") &&
		(typeof after === "string" || typeof after === "number")
	) {
		const a = String(before).trim()
		const b = String(after).trim()
		if (a === b) return true
		if (a !== "" && b !== "" && Number.isFinite(Number(a)) && Number.isFinite(Number(b))) {
			return Number(a) === Number(b)
		}
		return false
	}

	if (typeof before === "object" && typeof after === "object") {
		// A graph, compared whole. It is stored and replaced in one piece, so
		// "the flow changed" is the useful granularity — a node-level diff would
		// be a different feature, on a canvas rather than in a list.
		return JSON.stringify(before) === JSON.stringify(after)
	}

	return false
}

export function diffVersions(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): FieldChange[] {
	const changes: FieldChange[] = []

	for (const spec of FIELDS) {
		const from = before[spec.field]
		const to = after[spec.field]
		if (unchanged(spec.kind, from, to)) continue
		changes.push({ field: spec.field, label: spec.label, kind: spec.kind, before: from, after: to })
	}

	return changes
}

/** The fields a diff considers, for anything that needs to say so. */
export const DIFFED_FIELDS: readonly string[] = FIELDS.map((spec) => spec.field)
