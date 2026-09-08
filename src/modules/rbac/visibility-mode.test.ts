import { describe, expect, it } from "vitest"

import type { GrantEffect } from "./grant-decision"
import { decidesTheSame, includesUnderMode, visibilityMode } from "./visibility-mode"

const EFFECT_SETS: GrantEffect[][] = [
	[],
	["allow"],
	["deny"],
	["allow", "allow"],
	["deny", "deny"],
	["allow", "deny"],
	["deny", "allow"],
]

describe("how a list is filtered", () => {
	it("removes what was denied when the role already granted it everywhere", () => {
		expect(visibilityMode(true)).toBe("excludeDenied")
		expect(includesUnderMode("excludeDenied", [])).toBe(true)
		expect(includesUnderMode("excludeDenied", ["deny"])).toBe(false)
	})

	it("shows only what was explicitly allowed when the role granted nothing", () => {
		expect(visibilityMode(false)).toBe("onlyAllowed")
		expect(includesUnderMode("onlyAllowed", [])).toBe(false)
		expect(includesUnderMode("onlyAllowed", ["allow"])).toBe(true)
		expect(includesUnderMode("onlyAllowed", ["allow", "deny"])).toBe(false)
	})

	/**
	 * The property that matters. A list naming a resource the caller cannot open
	 * is a disclosure; a list hiding one they can open is a bug nobody can
	 * reproduce. Both are the same mistake — the two decisions disagreeing.
	 */
	it.each(EFFECT_SETS)("agrees with the row-level check for %j", (...effects) => {
		const set = effects.flat() as GrantEffect[]
		expect(decidesTheSame(true, set)).toBe(true)
		expect(decidesTheSame(false, set)).toBe(true)
	})
})
