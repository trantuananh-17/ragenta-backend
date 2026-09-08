import { describe, expect, it } from "vitest"

import { isBreakGlassAdmin } from "./break-glass"

const LISTED = ["user_listed"]

describe("the administrator who needs no database row", () => {
	it("admits an id named in the environment, whatever its role says", () => {
		expect(isBreakGlassAdmin({ id: "user_listed", role: null }, LISTED)).toBe(true)
		expect(isBreakGlassAdmin({ id: "user_listed", role: "user" }, LISTED)).toBe(true)
	})

	it("admits the role Better Auth's admin plugin writes", () => {
		expect(isBreakGlassAdmin({ id: "u1", role: "admin" }, LISTED)).toBe(true)
		expect(isBreakGlassAdmin({ id: "u1", role: "user,admin" }, LISTED)).toBe(true)
		expect(isBreakGlassAdmin({ id: "u1", role: " Admin " }, LISTED)).toBe(true)
	})

	it("refuses everybody else", () => {
		expect(isBreakGlassAdmin({ id: "u1", role: null }, LISTED)).toBe(false)
		expect(isBreakGlassAdmin({ id: "u1", role: "user" }, LISTED)).toBe(false)
		expect(isBreakGlassAdmin({ id: "u1" }, LISTED)).toBe(false)
		expect(isBreakGlassAdmin({ id: "u1", role: "admin" }, [])).toBe(true)
	})

	// A substring match would hand the console to a role named to describe
	// somebody rather than to empower them.
	it.each(["readonly-admin", "admins-watchlist", "not-admin", "administrator", "sub admin"])(
		"does not read %j as admin",
		(role) => {
			expect(isBreakGlassAdmin({ id: "u1", role }, LISTED)).toBe(false)
		},
	)
})
