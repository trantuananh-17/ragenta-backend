import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

import { ValidationError } from "../../../shared/errors"

/**
 * Outbound HTTP for agent tools, with the checks an SSRF surface needs.
 *
 * An agent fetches URLs a model chose, and a model can be talked into choosing
 * one by any document it read. That makes every fetch here a request an attacker
 * may control, aimed from **inside** the deployment's network — where the cloud
 * metadata endpoint, the database and every internal service live. The rules in
 * `.claude/rules/security.md` are implemented here and nowhere else, so there is
 * one place to audit:
 *
 * - only http and https, so `file:`, `gopher:` and friends are not reachable
 * - every resolved address is checked against private, loopback, link-local and
 *   unique-local ranges — the check is on the **address**, never on the hostname,
 *   because a name an attacker controls can resolve wherever they like
 * - redirects are followed by hand and re-checked at every hop, since a public
 *   URL that 302s to 169.254.169.254 defeats a check done only once
 * - size and time are capped, so a tool cannot be used to pull a 4 GB file into
 *   the worker's memory or to hold a run open indefinitely
 */
const MAX_REDIRECTS = 3
const MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 10_000

/** Private, loopback, link-local and carrier-grade NAT ranges, as prefixes. */
function isBlockedIpv4(address: string): boolean {
	const parts = address.split(".").map(Number)
	const [a = 0, b = 0] = parts
	if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true

	if (a === 0 || a === 10 || a === 127) return true
	if (a === 169 && b === 254) return true // link-local, and AWS/GCP metadata
	if (a === 172 && b >= 16 && b <= 31) return true
	if (a === 192 && b === 168) return true
	if (a === 192 && b === 0) return true // IETF protocol assignments
	if (a === 192 && b === 88) return true // 192.88.99.0/24 6to4 relay anycast
	if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
	if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
	if (a === 198 && b === 51) return true // TEST-NET-2
	if (a === 203 && b === 0) return true // TEST-NET-3
	if (a >= 224) return true // multicast and reserved
	return false
}

/**
 * IPv6, decided on the bytes rather than on how the address was spelled.
 *
 * String prefixes were wrong in both directions and quietly. `startsWith("fe80")`
 * covers `fe80::/16` while link-local is `fe80::/10`, so `fe90::1` and `febf::1`
 * were allowed. `new URL()` rewrites `[::ffff:127.0.0.1]` to the hex form
 * `::ffff:7f00:1`, and `[::127.0.0.1]` to `::7f00:1`, and neither matched a
 * regex written for the dotted one. There are at least four ways to write
 * loopback and five to reach 169.254.169.254, and a check that enumerates
 * spellings will always be one spelling behind.
 *
 * So the address is expanded to its sixteen bytes once, and every rule is a
 * prefix comparison on those bytes. `::ffff:a.b.c.d`, `::a.b.c.d`,
 * `64:ff9b::a.b.c.d` (NAT64) and `2002:a.b.c.d::` (6to4) all carry an IPv4
 * address inside them and are handed to the IPv4 rules, because each of them
 * reaches an IPv4 host on a network that offers the translation.
 */
function expandIpv6(address: string): number[] | null {
	const value = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? ""
	const [head = "", tail, extra] = value.split("::")
	if (extra !== undefined) return null

	// A trailing dotted quad — `::ffff:127.0.0.1` — is four more bytes, not a group.
	const toGroups = (part: string): number[] | null => {
		if (part === "") return []
		const groups: number[] = []
		for (const piece of part.split(":")) {
			if (piece.includes(".")) {
				const quad = piece.split(".").map(Number)
				if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
					return null
				}
				groups.push(((quad[0] ?? 0) << 8) | (quad[1] ?? 0), ((quad[2] ?? 0) << 8) | (quad[3] ?? 0))
				continue
			}
			if (!/^[0-9a-f]{1,4}$/.test(piece)) return null
			groups.push(Number.parseInt(piece, 16))
		}
		return groups
	}

	const left = toGroups(head)
	const right = tail === undefined ? [] : toGroups(tail)
	if (!left || !right) return null

	const missing = 8 - left.length - right.length
	if (tail === undefined ? missing !== 0 : missing < 0) return null
	const groups = [...left, ...Array<number>(tail === undefined ? 0 : missing).fill(0), ...right]
	if (groups.length !== 8) return null

	return groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff])
}

function isBlockedIpv6(address: string): boolean {
	const bytes = expandIpv6(address)
	// Unparseable is refused, not allowed. A spelling this cannot read is a
	// spelling whose destination is unknown, and the safe answer to that is no.
	if (!bytes) return true

	const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
	const asIpv4 = (offset: number) =>
		isBlockedIpv4(`${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`)

	if (bytes.every((byte) => byte === 0)) return true // ::
	if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true // ::1

	// fe80::/10 — link-local. The /10 is the reason this is a mask and not a
	// prefix string: fe80 through febf are all link-local.
	if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return true
	if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0xc0) return true // fec0::/10 site-local
	if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return true // fc00::/7 unique local
	if (bytes[0] === 0xff) return true // ff00::/8 multicast

	// Every way of carrying an IPv4 address inside an IPv6 one.
	if (starts(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff)) return asIpv4(12) // ::ffff:0:0/96
	if (starts(0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0)) return asIpv4(12) // ::ffff:0:0:0/96 (SIIT)
	if (starts(0, 0x64, 0xff, 0x9b)) return asIpv4(12) // 64:ff9b::/96 NAT64
	if (starts(0x20, 0x02)) return asIpv4(2) // 2002::/16 6to4
	// ::a.b.c.d — deprecated IPv4-compatible, still routable as the IPv4 host.
	if (bytes.slice(0, 12).every((byte) => byte === 0)) return asIpv4(12)

	return false
}

export function isBlockedAddress(address: string): boolean {
	const family = isIP(address)
	if (family === 4) return isBlockedIpv4(address)
	if (family === 6) return isBlockedIpv6(address)
	return true
}

/**
 * Every address the hostname resolves to must be allowed, not merely the first.
 * A name resolving to one public and one private address would otherwise be a
 * coin toss decided by whichever the connection happened to use.
 *
 * Exported because the browser tool sends its URL to a remote browser service
 * rather than fetching it here, and has to apply the same check first — a second
 * implementation of it would be a second place to get it wrong.
 */
export async function assertHostAllowed(hostname: string): Promise<void> {
	if (isIP(hostname)) {
		if (isBlockedAddress(hostname)) {
			throw new ValidationError("That address is not reachable from this service.")
		}
		return
	}

	let addresses: { address: string }[]
	try {
		addresses = await lookup(hostname, { all: true })
	} catch {
		throw new ValidationError(`"${hostname}" could not be resolved.`)
	}

	if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
		throw new ValidationError("That address is not reachable from this service.")
	}
}

export interface SafeFetchResult {
	status: number
	contentType: string
	body: string
	/** True when the body was cut off at the size cap rather than ending. */
	truncated: boolean
	/** The URL the response actually came from, after any redirects. */
	finalUrl: string
}

export async function safeFetch(
	rawUrl: string,
	options: {
		method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
		headers?: Record<string, string>
		body?: string
	},
	signal?: AbortSignal,
): Promise<SafeFetchResult> {
	let current: URL
	try {
		current = new URL(rawUrl)
	} catch {
		throw new ValidationError("That is not a valid URL.")
	}

	const timeout = AbortSignal.timeout(TIMEOUT_MS)
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

	const origin = current.origin
	// Caller headers carry credentials: `api_call` puts a decrypted connection
	// secret in `Authorization`, and so does a connection check. They are sent to
	// the origin the caller named and to no other, because a redirect is chosen by
	// whoever answered — and an open redirect on the connection's own host is
	// otherwise a way to post that secret to an attacker's server. Browsers strip
	// credentials across origins for this exact reason; there is no reason to be
	// laxer here, where the header is a customer's key.
	let carryHeaders = true

	for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
		if (current.protocol !== "http:" && current.protocol !== "https:") {
			throw new ValidationError("Only http and https URLs can be fetched.")
		}
		await assertHostAllowed(current.hostname)

		const response = await fetch(current, {
			method: options.method ?? "GET",
			// Manual, so each hop is re-checked. `follow` would let the runtime
			// chase a redirect into a private address without asking.
			redirect: "manual",
			headers: {
				// Sent so an operator reading their logs can see what this is.
				"user-agent": "Ragenta-Agent/1.0",
				...(carryHeaders ? options.headers : undefined),
			},
			body: carryHeaders ? options.body : undefined,
			signal: combined,
		})

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location")
			if (!location) return await read(response, current.toString())
			current = new URL(location, current)
			// Once, and it never comes back: a redirect chain that returns to the
			// original origin does not restore the credential, because the hop that
			// left it already told someone else where to send us.
			if (current.origin !== origin) carryHeaders = false
			continue
		}

		return await read(response, current.toString())
	}

	throw new ValidationError("That URL redirected too many times.")
}

async function read(response: Response, finalUrl: string): Promise<SafeFetchResult> {
	const contentType = response.headers.get("content-type") ?? ""
	const { body, truncated } = await readCappedText(response, MAX_BYTES)
	return { status: response.status, contentType, body, truncated, finalUrl }
}

/**
 * Reads at most `maxBytes` of a response, so a huge one cannot exhaust the
 * process. Exported because the browser tool talks to its service directly —
 * that endpoint is an operator's, not the model's, so it does not go through
 * `safeFetch`, but a rendered page is exactly the response that arrives
 * unbounded.
 */
export async function readCappedText(
	response: Response,
	maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
	const reader = response.body?.getReader()
	if (!reader) return { body: "", truncated: false }

	const decoder = new TextDecoder()
	let body = ""
	let bytes = 0
	let truncated = false

	try {
		while (bytes < maxBytes) {
			const { done, value } = await reader.read()
			if (done) break
			bytes += value.byteLength
			body += decoder.decode(value, { stream: true })
			if (bytes >= maxBytes) truncated = true
		}
	} finally {
		await reader.cancel().catch(() => {
			// The connection is already going away.
		})
	}

	return { body, truncated }
}
