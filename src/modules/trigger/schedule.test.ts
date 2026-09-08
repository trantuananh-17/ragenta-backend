import { describe, expect, it } from "vitest"

import { backoffMinutes, nextRun, validateCron } from "./schedule"

const at = (iso: string) => new Date(iso)

describe("reading a schedule", () => {
	it("accepts a five-field expression", () => {
		expect(validateCron("0 9 * * 1-5", "UTC")).toBeUndefined()
		expect(validateCron("*/15 * * * *", "Asia/Ho_Chi_Minh")).toBeUndefined()
	})

	/**
	 * The scan runs every minute, so a schedule finer than that would fire late
	 * and unpredictably rather than often. Refusing six fields says so at the
	 * moment somebody writes one, rather than leaving them to notice.
	 */
	it("refuses a six-field expression rather than firing it late", () => {
		expect(validateCron("*/10 * * * * *", "UTC")?.message).toMatch(/five-field/)
	})

	it.each(["", "nonsense", "* * *", "99 * * * *"])(
		"refuses %j with the parser's own reason",
		(expression) => {
			expect(validateCron(expression, "UTC")).toBeDefined()
		},
	)

	it("refuses a zone it cannot read", () => {
		expect(validateCron("0 9 * * *", "Mars/Olympus")).toBeDefined()
	})
})

describe("when a schedule next comes due", () => {
	it("is read in the trigger's own zone, not the server's", () => {
		// 09:00 in Ho Chi Minh City is 02:00 UTC. A schedule evaluated in UTC would
		// fire at 09:00 UTC — seven hours late, every day, silently.
		const due = nextRun("0 9 * * *", "Asia/Ho_Chi_Minh", at("2026-09-08T00:00:00Z"))
		expect(due?.toISOString()).toBe("2026-09-08T02:00:00.000Z")
	})

	it("gives the same expression a different instant in a different zone", () => {
		const saigon = nextRun("0 9 * * *", "Asia/Ho_Chi_Minh", at("2026-09-08T00:00:00Z"))
		const london = nextRun("0 9 * * *", "Europe/London", at("2026-09-08T00:00:00Z"))
		expect(saigon?.toISOString()).not.toBe(london?.toISOString())
	})

	it("moves to the next occurrence, never returning the instant it was given", () => {
		const from = at("2026-09-08T02:00:00Z")
		const due = nextRun("0 9 * * *", "Asia/Ho_Chi_Minh", from)
		expect(due!.getTime()).toBeGreaterThan(from.getTime())
		expect(due?.toISOString()).toBe("2026-09-09T02:00:00.000Z")
	})

	it("skips the weekend for a weekday schedule", () => {
		// 2026-09-12 is a Saturday.
		const due = nextRun("0 9 * * 1-5", "UTC", at("2026-09-11T10:00:00Z"))
		expect(due?.toISOString()).toBe("2026-09-14T09:00:00.000Z")
	})

	it("says nothing rather than guessing when the expression is unreadable", () => {
		expect(nextRun("nonsense", "UTC")).toBeUndefined()
		expect(nextRun("0 9 * * *", "Mars/Olympus")).toBeUndefined()
	})
})

describe("backing off a trigger that keeps failing", () => {
	it("waits nothing while it is working", () => {
		expect(backoffMinutes(0)).toBe(0)
	})

	it("doubles, so a broken trigger stops writing a failed run every minute", () => {
		expect(backoffMinutes(1)).toBe(1)
		expect(backoffMinutes(2)).toBe(2)
		expect(backoffMinutes(3)).toBe(4)
		expect(backoffMinutes(4)).toBe(8)
	})

	it("caps at an hour, so a trigger fixed at lunchtime runs that afternoon", () => {
		expect(backoffMinutes(10)).toBe(60)
		expect(backoffMinutes(1_000)).toBe(60)
	})
})
