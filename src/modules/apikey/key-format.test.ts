import { describe, expect, it } from "vitest"

import { KEY_PREFIX, generateKey, hashKey, hintFor, keyFromHeader, keysMatch } from "./key-format"

describe("generating a key", () => {
	it("carries a recognisable prefix, so a leaked one can be spotted by a scanner", () => {
		expect(generateKey().plaintext.startsWith(KEY_PREFIX)).toBe(true)
	})

	it("never repeats", () => {
		const keys = new Set(Array.from({ length: 100 }, () => generateKey().plaintext))
		expect(keys.size).toBe(100)
	})

	it("is long enough that guessing is not a strategy", () => {
		// 32 random bytes, base64url — 256 bits of entropy.
		expect(generateKey().plaintext.length).toBeGreaterThanOrEqual(KEY_PREFIX.length + 43)
	})

	it("stores a hash, not the key", () => {
		const key = generateKey()
		expect(key.hash).toBe(hashKey(key.plaintext))
		expect(key.hash).not.toContain(key.plaintext)
		expect(key.hash).toMatch(/^[0-9a-f]{64}$/)
	})
})

describe("the hint", () => {
	it("shows both ends and nothing in between", () => {
		const hint = hintFor("rag_abcdefghijklmnop")
		expect(hint).toBe("rag_abcd…mnop")
		expect(hint).not.toContain("efghijkl")
	})

	it("is far too short to reconstruct the key from", () => {
		const key = generateKey()
		expect(key.hint.length).toBeLessThan(key.plaintext.length / 2)
	})
})

describe("checking a presented key", () => {
	it("accepts the real one and refuses everything else", () => {
		const key = generateKey()
		expect(keysMatch(key.plaintext, key.hash)).toBe(true)
		expect(keysMatch(`${key.plaintext}x`, key.hash)).toBe(false)
		expect(keysMatch(generateKey().plaintext, key.hash)).toBe(false)
	})

	it("is not fooled by a prefix of the real key", () => {
		const key = generateKey()
		expect(keysMatch(key.plaintext.slice(0, -1), key.hash)).toBe(false)
	})
})

describe("reading a key off a request", () => {
	const key = `${KEY_PREFIX}${"a".repeat(43)}`

	it("takes it from an Authorization bearer header", () => {
		expect(keyFromHeader(`Bearer ${key}`)).toBe(key)
		expect(keyFromHeader(`bearer ${key}`)).toBe(key)
		expect(keyFromHeader(`  Bearer   ${key}  `)).toBe(key)
	})

	/**
	 * A key in a query string ends up in access logs, in browser history and in
	 * the Referer of every link on the page it loaded. Refusing is the point.
	 */
	it.each([
		undefined,
		"",
		key,
		`Basic ${key}`,
		"Bearer",
		"Bearer sk-not-ours",
		`Bearer ${KEY_PREFIX}short`,
		`Bearer ${KEY_PREFIX}${"a".repeat(400)}`,
		`Bearer ${key} extra`,
	])("refuses %j", (header) => {
		expect(keyFromHeader(header)).toBeUndefined()
	})

	it("does not touch a session cookie's territory", () => {
		expect(keyFromHeader("Bearer eyJhbGciOiJIUzI1NiJ9.x.y")).toBeUndefined()
	})
})
