import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import { createPkcePair, createState, safeReturnTo, stateBelongsTo } from "./pkce"
import type { OAuthState } from "./pkce"

const state = (over: Partial<OAuthState> = {}): OAuthState => ({
	state: "s",
	verifier: "v",
	workspaceId: "ws_1",
	userId: "user_1",
	provider: "google",
	returnTo: "/settings/connections",
	...over,
})

describe("PKCE", () => {
	it("derives the challenge from the verifier with S256", () => {
		const pair = createPkcePair()
		expect(pair.method).toBe("S256")
		expect(pair.challenge).toBe(
			createHash("sha256").update(pair.verifier).digest("base64url"),
		)
	})

	it("produces a verifier long enough to be a secret and short enough to be legal", () => {
		const { verifier } = createPkcePair()
		expect(verifier.length).toBeGreaterThanOrEqual(43)
		expect(verifier.length).toBeLessThanOrEqual(128)
		// Unreserved characters only — base64url, never base64.
		expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/)
	})

	it("never repeats a verifier or a state", () => {
		const verifiers = new Set(Array.from({ length: 50 }, () => createPkcePair().verifier))
		const states = new Set(Array.from({ length: 50 }, () => createState()))
		expect(verifiers.size).toBe(50)
		expect(states.size).toBe(50)
	})
})

describe("who may complete a callback", () => {
	it("accepts the person who started it, for the provider they started with", () => {
		expect(stateBelongsTo(state(), "google", "user_1")).toBe(true)
	})

	/**
	 * The check that turns a stolen state parameter into nothing. Without it an
	 * attacker completes their own authorization in the victim's browser and
	 * attaches their account to the victim's workspace — where the victim's agents
	 * then act through it.
	 */
	it("refuses somebody else finishing it", () => {
		expect(stateBelongsTo(state(), "google", "user_2")).toBe(false)
	})

	it("refuses a code being redeemed at a different provider", () => {
		expect(stateBelongsTo(state(), "slack", "user_1")).toBe(false)
	})

	it("is not fooled by a prefix", () => {
		expect(stateBelongsTo(state({ userId: "user_10" }), "google", "user_1")).toBe(false)
		expect(stateBelongsTo(state(), "google", "user_10")).toBe(false)
	})
})

describe("where the browser may be sent afterwards", () => {
	const fallback = "/settings/connections"

	it("keeps a path on our own app", () => {
		expect(safeReturnTo("/agents/abc", fallback)).toBe("/agents/abc")
		expect(safeReturnTo("/settings?tab=connections", fallback)).toBe(
			"/settings?tab=connections",
		)
	})

	/**
	 * An open redirect here is worth more than a normal one: it is reached the
	 * instant an authorization succeeds, which is exactly when somebody will
	 * believe a page that looks like the product and asks for their password.
	 */
	it.each([
		"https://evil.example",
		"//evil.example",
		"/\\evil.example",
		"/path\\..\\evil",
		"javascript:alert(1)",
		"http://localhost/steal",
		"agents",
		"",
	])("refuses %j and falls back", (value) => {
		expect(safeReturnTo(value, fallback)).toBe(fallback)
	})

	it("falls back when nothing was asked for", () => {
		expect(safeReturnTo(undefined, fallback)).toBe(fallback)
	})
})
