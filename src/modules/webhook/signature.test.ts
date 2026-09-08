import { describe, expect, it } from "vitest"

import {
	SIGNATURE_TOLERANCE_SECONDS,
	parseSignature,
	signPayload,
	verifySignature,
} from "./signature"

const SECRET = "whsec_a-secret-nobody-else-has"
const BODY = JSON.stringify({ event: "agent.run.succeeded", data: { runId: "run_1" } })
const NOW = 1_780_000_000

describe("signPayload", () => {
	it("produces a header a receiver can verify", () => {
		const header = signPayload(SECRET, BODY, NOW)
		expect(verifySignature(SECRET, BODY, header, NOW)).toBe(true)
	})

	it("is stable for the same input, so a retry sends the same signature", () => {
		expect(signPayload(SECRET, BODY, NOW)).toBe(signPayload(SECRET, BODY, NOW))
	})

	it("changes with the timestamp even though the body has not", () => {
		expect(signPayload(SECRET, BODY, NOW)).not.toBe(signPayload(SECRET, BODY, NOW + 1))
	})
})

describe("verifySignature", () => {
	it("refuses a body that was changed after signing", () => {
		const header = signPayload(SECRET, BODY, NOW)
		const tampered = BODY.replace("run_1", "run_2")
		expect(verifySignature(SECRET, tampered, header, NOW)).toBe(false)
	})

	it("refuses another workspace's secret", () => {
		const header = signPayload(SECRET, BODY, NOW)
		expect(verifySignature("whsec_someone-elses", BODY, header, NOW)).toBe(false)
	})

	/**
	 * The replay case, which is the reason the timestamp is signed rather than
	 * only sent. A captured delivery re-posted an hour later carries a valid MAC
	 * for its own timestamp — the age is what refuses it.
	 */
	it("refuses a delivery older than the tolerance", () => {
		const header = signPayload(SECRET, BODY, NOW)
		expect(
			verifySignature(SECRET, BODY, header, NOW + SIGNATURE_TOLERANCE_SECONDS + 1),
		).toBe(false)
		expect(verifySignature(SECRET, BODY, header, NOW + SIGNATURE_TOLERANCE_SECONDS)).toBe(
			true,
		)
	})

	it("refuses a delivery timestamped in the future", () => {
		const header = signPayload(SECRET, BODY, NOW + SIGNATURE_TOLERANCE_SECONDS + 1)
		expect(verifySignature(SECRET, BODY, header, NOW)).toBe(false)
	})

	/**
	 * Moving the timestamp in the header without re-signing must fail. If only the
	 * header's `t` were read for the age check and the signed string used some
	 * other timestamp, this would pass and the replay window would be unbounded.
	 */
	it("refuses a header whose timestamp was moved to make it look fresh", () => {
		const header = signPayload(SECRET, BODY, NOW - 10_000)
		const forged = header.replace(/t=\d+/, `t=${NOW}`)
		expect(verifySignature(SECRET, BODY, forged, NOW)).toBe(false)
	})

	it("refuses a header it cannot parse rather than treating it as absent", () => {
		expect(verifySignature(SECRET, BODY, "", NOW)).toBe(false)
		expect(verifySignature(SECRET, BODY, "nonsense", NOW)).toBe(false)
		expect(verifySignature(SECRET, BODY, `t=${NOW}`, NOW)).toBe(false)
		expect(verifySignature(SECRET, BODY, "v1=abcd", NOW)).toBe(false)
	})

	it("refuses a mac that is not hex, rather than throwing", () => {
		expect(verifySignature(SECRET, BODY, `t=${NOW},v1=zzzz`, NOW)).toBe(false)
	})

	it("refuses an empty mac", () => {
		expect(verifySignature(SECRET, BODY, `t=${NOW},v1=`, NOW)).toBe(false)
	})
})

describe("parseSignature", () => {
	it("reads the parts in either order", () => {
		const parsed = parseSignature(`v1=deadbeef,t=${NOW}`)
		expect(parsed).toEqual({ timestamp: NOW, mac: "deadbeef" })
	})

	it("ignores a version it does not know, so a later v2 does not break v1", () => {
		const parsed = parseSignature(`t=${NOW},v1=deadbeef,v2=cafe`)
		expect(parsed).toEqual({ timestamp: NOW, mac: "deadbeef" })
	})

	it("refuses a timestamp that is not a positive integer", () => {
		expect(parseSignature("t=0,v1=deadbeef")).toBeNull()
		expect(parseSignature("t=-1,v1=deadbeef")).toBeNull()
		expect(parseSignature("t=abc,v1=deadbeef")).toBeNull()
		expect(parseSignature("t=1.5,v1=deadbeef")).toBeNull()
	})
})
