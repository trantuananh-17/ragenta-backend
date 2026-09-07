import { afterEach, describe, expect, it, vi } from "vitest"

import { isBlockedAddress, safeFetch } from "./safe-fetch"

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

describe("credentials are not carried across an origin", () => {
	// `api_call` puts a decrypted connection secret in `Authorization`. An open
	// redirect on the connection's own host would otherwise hand that secret to
	// whoever the redirect names — and the model chooses the path, so a document
	// it read can steer it there.
	const AUTH = { authorization: "Bearer super-secret-token" }

	function stubHops(hops: Array<{ status: number; location?: string }>) {
		const seen: Array<{ url: string; authorization: string | undefined }> = []
		let index = 0
		vi.stubGlobal("fetch", async (url: unknown, init: unknown) => {
			const request = init as { headers?: Record<string, string> }
			seen.push({
				url: String(url),
				authorization: request.headers?.["authorization"],
			})
			const hop = hops[Math.min(index++, hops.length - 1)]!
			const headers = new Headers({ "content-type": "text/plain" })
			if (hop.location) headers.set("location", hop.location)
			return new Response("ok", { status: hop.status, headers })
		})
		return seen
	}

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("sends the credential to the origin the caller named", async () => {
		const seen = stubHops([{ status: 200 }])
		await safeFetch("https://93.184.216.34/v1/things", { headers: AUTH })
		expect(seen[0]?.authorization).toBe("Bearer super-secret-token")
	})

	it("drops it the moment a redirect leaves that origin", async () => {
		const seen = stubHops([
			{ status: 302, location: "https://1.1.1.1/collect" },
			{ status: 200 },
		])
		await safeFetch("https://93.184.216.34/v1/redirect", { headers: AUTH })

		expect(seen[0]?.authorization).toBe("Bearer super-secret-token")
		expect(seen[1]?.url).toContain("1.1.1.1")
		expect(seen[1]?.authorization).toBeUndefined()
	})

	it("keeps it across a redirect that stays on the same origin", async () => {
		const seen = stubHops([
			{ status: 301, location: "https://93.184.216.34/v2/things" },
			{ status: 200 },
		])
		await safeFetch("https://93.184.216.34/v1/things", { headers: AUTH })
		expect(seen[1]?.authorization).toBe("Bearer super-secret-token")
	})

	it("does not restore it if the chain comes back", async () => {
		// The hop that left already told a third party where to send us.
		const seen = stubHops([
			{ status: 302, location: "https://1.1.1.1/bounce" },
			{ status: 302, location: "https://93.184.216.34/v1/things" },
			{ status: 200 },
		])
		await safeFetch("https://93.184.216.34/start", { headers: AUTH })
		expect(seen[2]?.authorization).toBeUndefined()
	})
})
