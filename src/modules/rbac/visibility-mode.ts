import { decideResourcePermission } from "./grant-decision"
import type { GrantEffect } from "./grant-decision"

/**
 * How a list has to be filtered so that it names exactly the resources the
 * caller could open.
 *
 * There are only two shapes, and which one applies depends solely on whether the
 * caller's roles granted the permission workspace-wide:
 *
 * - `excludeDenied` — they hold it everywhere, so the list is everything minus
 *   the rows carrying a `deny` grant.
 * - `onlyAllowed` — they do not, so the list is only the rows carrying an
 *   `allow` grant, minus any that also carry a `deny`.
 *
 * Alone in its own file because it must agree with `decideResourcePermission`
 * exactly. A list that names a resource the caller cannot open is a disclosure;
 * one that hides a resource they can open is a bug report nobody can reproduce.
 * `visibility-mode.test.ts` asserts the two agree for every combination rather
 * than trusting that they read the same.
 */
export type VisibilityMode = "excludeDenied" | "onlyAllowed"

export function visibilityMode(grantedByRole: boolean): VisibilityMode {
	return grantedByRole ? "excludeDenied" : "onlyAllowed"
}

/**
 * Whether a row survives the filter. Not used by the query — the SQL does that —
 * but it is what the test compares against, and what a reader can check by eye.
 */
export function includesUnderMode(
	mode: VisibilityMode,
	effectsOnResource: readonly GrantEffect[],
): boolean {
	if (effectsOnResource.includes("deny")) return false
	return mode === "excludeDenied" || effectsOnResource.includes("allow")
}

/** The row-level answer, for the property the test asserts. */
export function decidesTheSame(
	grantedByRole: boolean,
	effectsOnResource: readonly GrantEffect[],
): boolean {
	return (
		includesUnderMode(visibilityMode(grantedByRole), effectsOnResource) ===
		decideResourcePermission(grantedByRole, effectsOnResource)
	)
}
