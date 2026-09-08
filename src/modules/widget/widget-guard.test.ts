import { describe, expect, it } from "vitest"

import {
	WIDGET_KEY_PREFIX,
	generateWidgetKey,
	isWidgetKey,
	newVisitorId,
	originAllowed,
	readVisitorToken,
	signVisitorToken,
} from "./widget-guard"

const SECRET = "a-test-secret-at-least-32-characters-long"

describe("the publishable key", () => {
	it("is named so nobody mistakes it for the secret one", () => {
		expect(generateWidgetKey().startsWith(WIDGET_KEY_PREFIX)).toBe(true)
		expect(WIDGET_KEY_PREFIX).not.toBe("rag_")
	})

	it("never repeats", () => {
		expect(new Set(Array.from({ length: 100 }, generateWidgetKey)).size).toBe(100)
	})

	it("refuses a secret key presented in its place", () => {
		expect(isWidgetKey(`rag_${"a".repeat(43)}`)).toBe(false)
		expect(isWidgetKey(generateWidgetKey())).toBe(true)
	})
})

describe("where a widget may be embedded", () => {
	const allowed = ["https://shop.example.com", "https://*.acme.test"]

	it("accepts an exact origin", () => {
		expect(originAllowed("https://shop.example.com", allowed)).toBe(true)
	})

	it("accepts a subdomain under a wildcard, and the apex", () => {
		expect(originAllowed("https://www.acme.test", allowed)).toBe(true)
		expect(originAllowed("https://acme.test", allowed)).toBe(true)
	})

	/**
	 * The classic version of this bug. `endsWith("example.com")` also accepts
	 * `notexample.com`, and a naive wildcard also accepts `acme.test.evil.net`.
	 */
	it.each([
		"https://notshop.example.com",
		"https://shop.example.com.evil.net",
		"https://acme.test.evil.net",
		"https://notacme.test",
		"http://shop.example.com",
		"https://shop.example.com:8443",
	])("refuses %j", (origin) => {
		expect(originAllowed(origin, allowed)).toBe(false)
	})

	it("refuses anything that is not an origin", () => {
		expect(originAllowed("https://shop.example.com/embed", allowed)).toBe(false)
		expect(originAllowed("not a url", allowed)).toBe(false)
		expect(originAllowed(undefined, allowed)).toBe(false)
	})

	/**
	 * A widget nobody has finished configuring accepts nothing. Defaulting an
	 * empty list to "anywhere" would be the wrong way round for a public endpoint
	 * that spends money.
	 */
	it("accepts nothing when no origin has been configured", () => {
		expect(originAllowed("https://shop.example.com", [])).toBe(false)
	})

	it("is not confused by a trailing slash or by casing", () => {
		expect(originAllowed("https://SHOP.example.com", ["https://shop.example.com/"])).toBe(true)
	})
})

describe("the visitor token", () => {
	const token = { widgetId: "w_1", visitorId: newVisitorId(), issuedAt: Date.now() }

	it("round-trips what it was given", () => {
		const signed = signVisitorToken(token, SECRET)
		expect(readVisitorToken(signed, SECRET, 60_000)?.visitorId).toBe(token.visitorId)
	})

	it("refuses one signed with a different secret", () => {
		const signed = signVisitorToken(token, "another-secret-that-is-long-enough!!")
		expect(readVisitorToken(signed, SECRET, 60_000)).toBeUndefined()
	})

	it("refuses a tampered payload", () => {
		const signed = signVisitorToken(token, SECRET)
		const [, signature] = signed.split(".")
		const forged = `${Buffer.from(
			JSON.stringify({ ...token, widgetId: "w_2" }),
		).toString("base64url")}.${signature}`
		expect(readVisitorToken(forged, SECRET, 60_000)).toBeUndefined()
	})

	it("treats an old token as no token, so the visitor simply starts again", () => {
		const old = signVisitorToken({ ...token, issuedAt: Date.now() - 100_000 }, SECRET)
		expect(readVisitorToken(old, SECRET, 60_000)).toBeUndefined()
	})

	it.each([undefined, "", "nonsense", "onlyonepart", "a.b.c"])(
		"refuses %j rather than throwing",
		(value) => {
			expect(readVisitorToken(value, SECRET, 60_000)).toBeUndefined()
		},
	)

	it("carries the widget, so a token minted for one cannot be used on another", () => {
		const signed = signVisitorToken(token, SECRET)
		expect(readVisitorToken(signed, SECRET, 60_000)?.widgetId).toBe("w_1")
	})
})
