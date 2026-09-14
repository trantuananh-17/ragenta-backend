import type { RunVisitor } from "./types"

const VISITOR_PLACEHOLDER = /\{\{\s*visitor\.(id|email)\s*\}\}/g

/**
 * Fills `{{visitor.id}}` / `{{visitor.email}}` from the run's signed visitor.
 *
 * The model writes the placeholder, never the value: it does not know the
 * visitor's email and cannot be told a different one by a fetched page. A
 * placeholder with no visitor behind it — an anonymous chat, or a signed-in one
 * without an email — is a refusal rather than an empty string, because an
 * identity-scoped call made with a blank identity is the far API's problem to
 * notice and not all of them do.
 */
export function fillVisitor(
	template: string,
	visitor: RunVisitor | undefined,
	encode: (value: string) => string = (value) => value,
): string | undefined {
	let missing = false
	const filled = template.replace(VISITOR_PLACEHOLDER, (_match, field: "id" | "email") => {
		const value = visitor?.[field]
		if (value === undefined) {
			missing = true
			return ""
		}
		return encode(value)
	})
	return missing ? undefined : filled
}
