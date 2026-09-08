import { describe, expect, it } from "vitest"

import { createRoleSchema, setRolesSchema, updateRoleSchema } from "./rbac.dto"

const valid = {
	key: "content-editor",
	name: "Content editor",
	scope: "workspace" as const,
	permissions: ["knowledgeBase.read", "document.create"],
}

describe("creating a role", () => {
	it("accepts a role composed from permissions the catalogue defines", () => {
		const parsed = createRoleSchema.parse(valid)
		expect(parsed.permissions).toEqual(["knowledgeBase.read", "document.create"])
		expect(parsed.description).toBe("")
	})

	// A role holding a key nothing checks is a control on a screen that does
	// nothing, and the wrong moment to find out is when somebody relies on it.
	it("refuses a permission the catalogue does not define", () => {
		expect(() =>
			createRoleSchema.parse({ ...valid, permissions: ["knowledgeBase.explode"] }),
		).toThrow()
		expect(() => createRoleSchema.parse({ ...valid, permissions: ["*"] })).toThrow()
	})

	it.each(["Content Editor", "content editor", "-editor", "9lives", "editor!", "a"])(
		"refuses %j as a key, because the key goes in URLs and in member.role",
		(key) => {
			expect(() => createRoleSchema.parse({ ...valid, key })).toThrow()
		},
	)

	it("allows a role with no permissions, which is a role that grants nothing", () => {
		expect(createRoleSchema.parse({ ...valid, permissions: [] }).permissions).toEqual([])
	})
})

describe("updating a role", () => {
	it("refuses an empty change rather than writing nothing and reporting success", () => {
		expect(() => updateRoleSchema.parse({})).toThrow()
	})

	it("tells an empty permission list apart from an absent one", () => {
		expect(updateRoleSchema.parse({ permissions: [] }).permissions).toEqual([])
		expect(updateRoleSchema.parse({ name: "Renamed" }).permissions).toBeUndefined()
	})
})

describe("assigning roles", () => {
	it("accepts a list and caps how long it may be", () => {
		expect(setRolesSchema.parse({ roleIds: ["a", "b"] }).roleIds).toEqual(["a", "b"])
		expect(() =>
			setRolesSchema.parse({ roleIds: Array.from({ length: 17 }, (_, i) => `r${i}`) }),
		).toThrow()
	})
})
