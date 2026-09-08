import { describe, expect, it } from "vitest"

import { primarySystemRoleId } from "./primary-role"

describe("the role Better Auth stored", () => {
	it.each(["owner", "admin", "member", "viewer"])("maps %s to its own system role", (key) => {
		expect(primarySystemRoleId(key)).toBe(`system:workspace:${key}`)
	})

	it("reads the first entry of a comma list, which is what Better Auth documents", () => {
		expect(primarySystemRoleId("admin,member")).toBe("system:workspace:admin")
		expect(primarySystemRoleId("owner, admin")).toBe("system:workspace:owner")
	})

	it("tolerates the spacing and casing a hand-written value arrives with", () => {
		expect(primarySystemRoleId("  Owner  ")).toBe("system:workspace:owner")
		expect(primarySystemRoleId("ADMIN")).toBe("system:workspace:admin")
	})

	// Every one of these would grant more than it should if the string were
	// trusted as a role key, or if an unknown value fell back upward.
	it.each(["", "   ", ",", "superadmin", "Owner Of Everything", "owner;admin", "'owner'"])(
		"gives %j the least privileged role rather than guessing",
		(value) => {
			expect(primarySystemRoleId(value)).toBe("system:workspace:member")
		},
	)

	it("does not let a platform role name reach a workspace membership", () => {
		expect(primarySystemRoleId("superadmin")).toBe("system:workspace:member")
		expect(primarySystemRoleId("finance")).toBe("system:workspace:member")
	})
})
