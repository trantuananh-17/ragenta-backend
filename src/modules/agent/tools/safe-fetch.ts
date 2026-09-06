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
	if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
	if (a >= 224) return true // multicast and reserved
	return false
}

function isBlockedIpv6(address: string): boolean {
	const value = address.toLowerCase().replace(/^\[|\]$/g, "")
	if (value === "::" || value === "::1") return true
	if (value.startsWith("fe80")) return true // link-local
	if (value.startsWith("fc") || value.startsWith("fd")) return true // unique local
	if (value.startsWith("ff")) return true // multicast
	// An IPv4-mapped address reaches the same host by another spelling.
	const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
	if (mapped?.[1]) return isBlockedIpv4(mapped[1])
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
 */
async function assertHostAllowed(hostname: string): Promise<void> {
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
	options: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string },
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
				...options.headers,
			},
			body: options.body,
			signal: combined,
		})

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location")
			if (!location) return await read(response, current.toString())
			current = new URL(location, current)
			continue
		}

		return await read(response, current.toString())
	}

	throw new ValidationError("That URL redirected too many times.")
}

/** Reads at most `MAX_BYTES`, so a huge response cannot exhaust the process. */
async function read(response: Response, finalUrl: string): Promise<SafeFetchResult> {
	const contentType = response.headers.get("content-type") ?? ""
	const reader = response.body?.getReader()

	if (!reader) {
		return { status: response.status, contentType, body: "", truncated: false, finalUrl }
	}

	const decoder = new TextDecoder()
	let body = ""
	let bytes = 0
	let truncated = false

	try {
		while (bytes < MAX_BYTES) {
			const { done, value } = await reader.read()
			if (done) break
			bytes += value.byteLength
			body += decoder.decode(value, { stream: true })
			if (bytes >= MAX_BYTES) truncated = true
		}
	} finally {
		await reader.cancel().catch(() => {
			// The connection is already going away.
		})
	}

	return { status: response.status, contentType, body, truncated, finalUrl }
}
