import { describe, expect, it } from "vitest"

import { WEBHOOK_EVENTS, isWebhookEvent, subscribes } from "./events"

describe("WEBHOOK_EVENTS", () => {
	it("has no duplicate keys", () => {
		const keys = WEBHOOK_EVENTS.map((event) => event.key)
		expect(new Set(keys).size).toBe(keys.length)
	})

	/**
	 * Lower-case dotted segments, most general first, so a subscription list sorts
	 * into groups a person can scan. Not a fixed segment count: `document.ingested`
	 * has no middle noun to invent, and `document.ingest.succeeded` would be worse
	 * English for the sake of a regex.
	 */
	it("names every event in lower-case dotted segments", () => {
		for (const event of WEBHOOK_EVENTS) {
			expect(event.key).toMatch(/^[a-z]+(\.[a-z]+){1,2}$/)
		}
	})

	it("says what each event carries, because a subscription is chosen from that", () => {
		for (const event of WEBHOOK_EVENTS) {
			expect(event.summary.length).toBeGreaterThan(10)
			expect(event.fields.length).toBeGreaterThan(0)
		}
	})
})

describe("subscribes", () => {
	/**
	 * The one that matters. An empty list is the inverse of the MCP tool
	 * allowlist, where empty means everything — here it must mean nothing, or an
	 * endpoint created without choosing anything would start posting a customer's
	 * server payloads it has never seen a schema for.
	 */
	it("matches nothing when no event was chosen", () => {
		expect(subscribes([], "agent.run.succeeded")).toBe(false)
		for (const event of WEBHOOK_EVENTS) {
			expect(subscribes([], event.key)).toBe(false)
		}
	})

	it("matches only what was chosen", () => {
		const chosen = ["agent.run.succeeded"]
		expect(subscribes(chosen, "agent.run.succeeded")).toBe(true)
		expect(subscribes(chosen, "agent.run.failed")).toBe(false)
	})
})

describe("isWebhookEvent", () => {
	it("accepts every key in the catalogue", () => {
		for (const event of WEBHOOK_EVENTS) {
			expect(isWebhookEvent(event.key)).toBe(true)
		}
	})

	it("refuses one that is not", () => {
		expect(isWebhookEvent("agent.run.pending")).toBe(false)
		expect(isWebhookEvent("*")).toBe(false)
		expect(isWebhookEvent("")).toBe(false)
	})
})
