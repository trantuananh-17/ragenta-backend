import { describe, expect, it } from "vitest"

import { decideResourcePermission } from "./grant-decision"

describe("combining a role's permission with grants on one resource", () => {
	it("lets a role's permission through when nothing was said about the resource", () => {
		expect(decideResourcePermission(true, [])).toBe(true)
		expect(decideResourcePermission(false, [])).toBe(false)
	})

	it("lets an allow widen a role that did not grant it", () => {
		expect(decideResourcePermission(false, ["allow"])).toBe(true)
	})

	it("lets a deny narrow a role that did grant it", () => {
		expect(decideResourcePermission(true, ["deny"])).toBe(false)
	})

	// The case the whole layer exists for: adding a role must not undo a deny,
	// or the narrowing is a control that stops working the moment somebody is
	// promoted.
	it("keeps deny winning however many allows sit beside it", () => {
		expect(decideResourcePermission(true, ["allow", "deny"])).toBe(false)
		expect(decideResourcePermission(false, ["allow", "allow", "deny"])).toBe(false)
		expect(decideResourcePermission(true, ["deny", "allow"])).toBe(false)
	})

	it("treats several allows as one", () => {
		expect(decideResourcePermission(false, ["allow", "allow"])).toBe(true)
	})
})
