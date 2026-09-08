import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * How a receiver knows a delivery came from us and is not a replay.
 *
 * `X-Ragenta-Signature: t=<unix seconds>,v1=<hex hmac>`, over
 * `<t>.<raw body>` with the endpoint's secret. The timestamp is **inside** the
 * signed string rather than only in the header, which is the whole point: a
 * header an attacker can rewrite proves nothing, so binding it to the signature
 * is what makes a captured delivery unreplayable after the tolerance window.
 *
 * Deliberately the same shape Stripe uses. Not out of deference — because the
 * receiving end is somebody's afternoon, and a scheme they have implemented
 * before is one they will implement correctly.
 */
const VERSION = "v1"

/** How old a delivery may be and still be accepted. Five minutes, like Stripe. */
export const SIGNATURE_TOLERANCE_SECONDS = 300

export function signPayload(
	secret: string,
	body: string,
	timestampSeconds: number,
): string {
	const mac = createHmac("sha256", secret)
		.update(`${timestampSeconds}.${body}`)
		.digest("hex")
	return `t=${timestampSeconds},${VERSION}=${mac}`
}

export interface ParsedSignature {
	timestamp: number
	mac: string
}

/**
 * Reads a signature header back.
 *
 * Tolerant of the parts arriving in either order and of an unknown `vN=` the
 * header may gain later, strict about everything else — a header we cannot parse
 * is not a header we treat as valid.
 */
export function parseSignature(header: string): ParsedSignature | null {
	let timestamp: number | null = null
	let mac: string | null = null

	for (const part of header.split(",")) {
		const [key, value] = part.trim().split("=")
		if (!key || !value) continue
		if (key === "t") {
			const parsed = Number(value)
			if (!Number.isInteger(parsed) || parsed <= 0) return null
			timestamp = parsed
		} else if (key === VERSION) {
			mac = value
		}
	}

	if (timestamp === null || mac === null) return null
	return { timestamp, mac }
}

/**
 * Verifies a delivery the way a receiver should.
 *
 * Exported and tested here because it is the half of the contract we ask other
 * people to implement: a documented scheme nobody has run once is a scheme with
 * a mistake in it. The comparison is constant time so the number of matching
 * leading bytes is not observable.
 */
export function verifySignature(
	secret: string,
	body: string,
	header: string,
	nowSeconds: number,
	toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
	const parsed = parseSignature(header)
	if (!parsed) return false

	// Both directions: a future timestamp is as suspect as an old one, and
	// accepting it would let a captured delivery be held and replayed later.
	if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) return false

	const expected = createHmac("sha256", secret)
		.update(`${parsed.timestamp}.${body}`)
		.digest("hex")

	const a = Buffer.from(expected, "hex")
	const b = Buffer.from(parsed.mac, "hex")
	return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}
