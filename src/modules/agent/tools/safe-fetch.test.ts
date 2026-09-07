import { describe, expect, it } from "vitest"

import { isBlockedAddress } from "./safe-fetch"

/**
 * Every spelling of an address that must not be reachable from inside the
 * deployment network.
 *
 * These exist because the first implementation matched strings. `new URL()`
 * normalises `[::ffff:127.0.0.1]` to `::ffff:7f00:1` and `[::127.0.0.1]` to
 * `::7f00:1`, so a check written against the dotted spelling never saw either —
 * and 169.254.169.254 is the cloud metadata endpoint, which hands out
 * credentials to whoever asks.
 */
describe("addresses that must be refused", () => {
	const blocked = [
		// IPv4
		"127.0.0.1",
		"169.254.169.254",
		"10.0.0.1",
		"172.16.0.1",
		"192.168.1.1",
		"100.64.0.1",
		"0.0.0.0",
		"198.18.0.1",
		// IPv6 loopback and unspecified
		"::1",
		"::",
		// link-local /10 — not just fe80::/16
		"fe80::1",
		"fe90::1",
		"febf::1",
		"fec0::1",
		// unique local /7
		"fc00::1",
		"fd00::1",
		// IPv4 carried inside IPv6, in each spelling
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"::ffff:169.254.169.254",
		"::ffff:a9fe:a9fe",
		"::ffff:0:7f00:1",
		"::127.0.0.1",
		"::7f00:1",
		"64:ff9b::7f00:1",
		"64:ff9b::169.254.169.254",
		"2002:7f00:1::",
		"2002:a9fe:a9fe::",
	]

	for (const address of blocked) {
		it(`refuses ${address}`, () => {
			expect(isBlockedAddress(address)).toBe(true)
		})
	}
})

describe("addresses that must still be reachable", () => {
	// The check has to stay useful. Blocking everything would pass every test
	// above and make the tool worthless.
	const allowed = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"]

	for (const address of allowed) {
		it(`allows ${address}`, () => {
			expect(isBlockedAddress(address)).toBe(false)
		})
	}
})

describe("anything unreadable is refused rather than allowed", () => {
	for (const value of ["", "not-an-address", "::ffff:999.1.1.1", "1:2:3::4::5", "12345::1"]) {
		it(`refuses ${JSON.stringify(value)}`, () => {
			expect(isBlockedAddress(value)).toBe(true)
		})
	}
})
