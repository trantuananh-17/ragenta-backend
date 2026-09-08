import { describe, expect, it } from "vitest"

import { clientAddress } from "./client-address"

/**
 * The spoofing case is the reason this is tested at all.
 *
 * `X-Forwarded-For` is a list a client can start and nginx appends to, so
 * reading it from the front hands every caller a fresh rate-limit bucket per
 * request — one header away from no limiter at all. Reading from the back is
 * not a style preference, and a refactor that "simplifies" it to `[0]` should
 * fail here rather than in production.
 */
describe("clientAddress", () => {
	it("prefers the address nginx set for itself", () => {
		expect(clientAddress("203.0.113.9", "198.51.100.1, 203.0.113.9")).toBe("203.0.113.9")
	})

	it("takes the last hop of a forwarded chain, not the first", () => {
		expect(clientAddress(undefined, "198.51.100.1, 203.0.113.9")).toBe("203.0.113.9")
	})

	it("ignores a chain a caller invented when the real address is present", () => {
		expect(clientAddress("203.0.113.9", "127.0.0.1")).toBe("203.0.113.9")
	})

	it("reads a single-entry chain", () => {
		expect(clientAddress(undefined, "203.0.113.9")).toBe("203.0.113.9")
	})

	it("trims the whitespace a chain is written with", () => {
		expect(clientAddress(undefined, "198.51.100.1,   203.0.113.9  ")).toBe("203.0.113.9")
	})

	it("treats a blank header as no header", () => {
		expect(clientAddress("   ", "")).toBeUndefined()
	})

	it("skips empty entries rather than returning one", () => {
		expect(clientAddress(undefined, "203.0.113.9, ,")).toBe("203.0.113.9")
	})

	it("reports nothing when neither header is present", () => {
		expect(clientAddress(undefined, undefined)).toBeUndefined()
	})
})
