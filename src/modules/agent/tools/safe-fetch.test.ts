import { Readable } from "node:stream"
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { ClientRequest, IncomingMessage } from "node:http"
import type { LookupFunction } from "node:net"

import { isBlockedAddress, safeFetch } from "./safe-fetch"

/**
 * `node:http` and `node:https` stand in for the network, not `fetch`, because
 * the request stopped being made by `fetch` — see `send` in `safe-fetch.ts`.
 * The resolver is stubbed alongside them, which is what makes DNS rebinding
 * expressible without a DNS server: it simply answers differently the second
 * time it is asked.
 */
const transport = vi.hoisted(() => vi.fn())
const resolveName = vi.hoisted(() => vi.fn())

vi.mock("node:http", () => ({ request: transport }))
vi.mock("node:https", () => ({ request: transport }))
vi.mock("node:dns/promises", () => ({ lookup: resolveName }))

afterEach(() => {
	vi.resetAllMocks()
})

/** What `send` puts on the wire, as it builds it. */
interface SentRequest {
	hostname: string
	path: string
	method: string
	headers: Record<string, string>
	lookup: LookupFunction
}

/** One canned response per hop, the last repeating if the chain runs on. */
function stubHops(hops: Array<{ status: number; location?: string }>): SentRequest[] {
	const seen: SentRequest[] = []

	transport.mockImplementation(
		(options: SentRequest, onResponse: (message: IncomingMessage) => void) => {
			const hop = hops[Math.min(seen.length, hops.length - 1)]!
			seen.push(options)

			const message = Readable.from([Buffer.from("ok")]) as unknown as IncomingMessage
			message.statusCode = hop.status
			message.headers = { "content-type": "text/plain" }
			if (hop.location) message.headers["location"] = hop.location

			queueMicrotask(() => onResponse(message))
			return { on: () => undefined, end: () => undefined } as unknown as ClientRequest
		},
	)

	return seen
}

/** The address the socket was pinned to, read back out of its `lookup`. */
function pinnedAddress(options: SentRequest): string {
	let pinned = ""
	options.lookup("ignored", { all: true }, (_error, address) => {
		pinned = Array.isArray(address) ? (address[0]?.address ?? "") : address
	})
	return pinned
}

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

	it("sends the credential to the origin the caller named", async () => {
		const seen = stubHops([{ status: 200 }])
		await safeFetch("https://93.184.216.34/v1/things", { headers: AUTH })
		expect(seen[0]?.headers["authorization"]).toBe("Bearer super-secret-token")
	})

	it("drops it the moment a redirect leaves that origin", async () => {
		const seen = stubHops([
			{ status: 302, location: "https://1.1.1.1/collect" },
			{ status: 200 },
		])
		await safeFetch("https://93.184.216.34/v1/redirect", { headers: AUTH })

		expect(seen[0]?.headers["authorization"]).toBe("Bearer super-secret-token")
		expect(seen[1]?.hostname).toBe("1.1.1.1")
		expect(seen[1]?.headers["authorization"]).toBeUndefined()
	})

	it("keeps it across a redirect that stays on the same origin", async () => {
		const seen = stubHops([
			{ status: 301, location: "https://93.184.216.34/v2/things" },
			{ status: 200 },
		])
		await safeFetch("https://93.184.216.34/v1/things", { headers: AUTH })
		expect(seen[1]?.headers["authorization"]).toBe("Bearer super-secret-token")
	})

	it("does not restore it if the chain comes back", async () => {
		// The hop that left already told a third party where to send us.
		const seen = stubHops([
			{ status: 302, location: "https://1.1.1.1/bounce" },
			{ status: 302, location: "https://93.184.216.34/v1/things" },
			{ status: 200 },
		])
		await safeFetch("https://93.184.216.34/start", { headers: AUTH })
		expect(seen[2]?.headers["authorization"]).toBeUndefined()
	})
})

/**
 * The hole this closes is time-of-check to time-of-use.
 *
 * `assertHostAllowed` resolved the name and approved the answer, and then the
 * URL was handed to `fetch`, which resolved it all over again. A record with a
 * zero TTL that answers publicly for the first query and `127.0.0.1` for the
 * second passed the guard and reached loopback — where, on a deployment host,
 * Postgres and Redis listen and the metadata endpoint is one hop away. Nothing
 * about the address ranges was wrong; the request was simply not going where
 * the check had looked.
 */
describe("the request goes to the address that was vetted", () => {
	it("connects to the answer it checked, not to the one the second query gives", async () => {
		resolveName
			.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
			.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
		const seen = stubHops([{ status: 200 }])

		await safeFetch("https://rebind.example/thing", {})

		expect(pinnedAddress(seen[0]!)).toBe("93.184.216.34")
		// The second answer is never asked for, which is the point: there is no
		// second query for an attacker to answer differently.
		expect(resolveName).toHaveBeenCalledTimes(1)
	})

	it("pins every redirect hop, since one unpinned hop is the whole hole again", async () => {
		resolveName
			.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
			.mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }])
			.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
		const seen = stubHops([
			{ status: 302, location: "https://second.example/there" },
			{ status: 200 },
		])

		await safeFetch("https://first.example/here", {})

		expect(pinnedAddress(seen[0]!)).toBe("93.184.216.34")
		expect(pinnedAddress(seen[1]!)).toBe("1.1.1.1")
		expect(resolveName).toHaveBeenCalledTimes(2)
	})

	it("still addresses the request to the hostname", async () => {
		// `hostname` is what Node writes into the `Host` header, what it offers as
		// the SNI name and what it verifies the certificate against. Putting the
		// pinned address here instead would have broken virtual hosting and TLS
		// both; it belongs in `lookup` and nowhere else.
		resolveName.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
		const seen = stubHops([{ status: 200 }])

		await safeFetch("https://pinned.example/thing?q=1", {})

		expect(seen[0]?.hostname).toBe("pinned.example")
		expect(seen[0]?.path).toBe("/thing?q=1")
	})

	it("refuses the name outright when what it resolves to is blocked", async () => {
		resolveName.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }])
		const seen = stubHops([{ status: 200 }])

		await expect(safeFetch("https://metadata.example/latest", {})).rejects.toThrow(
			"not reachable",
		)
		expect(seen).toHaveLength(0)
	})
})

/**
 * A server that compresses anyway.
 *
 * The request asks for `identity`, and one that honours it needs none of this.
 * Enough do not, and `http.request` — unlike the `fetch` this replaced — hands
 * the compressed bytes on undecoded. Without the decode a page arrives at the
 * model as a screenful of binary presented as its text, which is worse than an
 * error because nothing about it says it failed.
 */
describe("a coding the server applied anyway is undone", () => {
	function stubEncoded(encoding: string, bytes: Buffer): void {
		transport.mockImplementation(
			(_options: SentRequest, onResponse: (message: IncomingMessage) => void) => {
				const message = Readable.from([bytes]) as unknown as IncomingMessage
				message.statusCode = 200
				message.headers = { "content-type": "text/plain", "content-encoding": encoding }
				queueMicrotask(() => onResponse(message))
				return { on: () => undefined, end: () => undefined } as unknown as ClientRequest
			},
		)
	}

	it("reads a gzipped body as its text", async () => {
		stubEncoded("gzip", gzipSync(Buffer.from("the page said this")))
		const result = await safeFetch("https://93.184.216.34/page", {})
		expect(result.body).toBe("the page said this")
	})

	it("reads a deflated body as its text", async () => {
		stubEncoded("deflate", deflateSync(Buffer.from("deflated all the same")))
		expect((await safeFetch("https://93.184.216.34/page", {})).body).toBe("deflated all the same")
	})

	it("reads a brotli body as its text", async () => {
		stubEncoded("br", brotliCompressSync(Buffer.from("brotli too")))
		expect((await safeFetch("https://93.184.216.34/page", {})).body).toBe("brotli too")
	})

	it("is not fooled by the casing or padding a header may arrive with", async () => {
		stubEncoded("  GZIP ", gzipSync(Buffer.from("still gzip")))
		expect((await safeFetch("https://93.184.216.34/page", {})).body).toBe("still gzip")
	})

	it("leaves an uncompressed body alone", async () => {
		stubEncoded("identity", Buffer.from("plain text"))
		expect((await safeFetch("https://93.184.216.34/page", {})).body).toBe("plain text")
	})

	it("asks for no coding in the first place", async () => {
		const seen = stubHops([{ status: 200 }])
		await safeFetch("https://93.184.216.34/page", {})
		expect(seen[0]?.headers["accept-encoding"]).toBe("identity")
	})
})
