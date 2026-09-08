import { describe, expect, it } from "vitest"

import { platformUsageQuerySchema } from "./platform-usage.dto"

function parse(query: Record<string, string>) {
	return platformUsageQuerySchema.parse(query)
}

describe("the date range a spend report is read over", () => {
	it("reads both ends as UTC midnight, not as the server's local zone", () => {
		const { from, to } = parse({ from: "2026-09-01", to: "2026-09-08" })
		expect(from.toISOString()).toBe("2026-09-01T00:00:00.000Z")
		expect(to.toISOString()).toBe("2026-09-08T00:00:00.000Z")
	})

	// The end is exclusive, so `to` has to be the day *after* the last one wanted
	// or today's spend is missing from a report somebody ran today.
	it("defaults the end to tomorrow, so today is included", () => {
		const { to } = parse({})
		const tomorrow = new Date()
		tomorrow.setUTCHours(0, 0, 0, 0)
		tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
		expect(to.toISOString()).toBe(tomorrow.toISOString())
	})

	it("defaults the start to thirty days before the end", () => {
		const { from, to } = parse({ to: "2026-09-08" })
		expect(from.toISOString()).toBe("2026-08-09T00:00:00.000Z")
		expect((to.getTime() - from.getTime()) / 86_400_000).toBe(30)
	})

	it("crosses a month and a year boundary without arithmetic drift", () => {
		expect(parse({ to: "2026-01-05" }).from.toISOString()).toBe("2025-12-06T00:00:00.000Z")
		expect(parse({ to: "2026-03-01" }).from.toISOString()).toBe("2026-01-30T00:00:00.000Z")
	})

	it("refuses a range that ends before it starts, rather than returning nothing", () => {
		expect(() => parse({ from: "2026-09-08", to: "2026-09-01" })).toThrow()
		expect(() => parse({ from: "2026-09-08", to: "2026-09-08" })).toThrow()
	})

	it.each(["2026-9-8", "08/09/2026", "yesterday", "2026-09-08T00:00:00Z"])(
		"refuses %j rather than guessing what it means",
		(from) => {
			expect(() => parse({ from })).toThrow()
		},
	)

	it("caps how many workspaces one report will name", () => {
		expect(parse({}).limit).toBe(25)
		expect(parse({ limit: "100" }).limit).toBe(100)
		expect(() => parse({ limit: "101" })).toThrow()
		expect(() => parse({ limit: "0" })).toThrow()
	})
})
