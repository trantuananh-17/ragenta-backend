import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * The decisions that stand in for a session on the one public surface here.
 *
 * Alone and tested, because a widget is the first thing in this product a
 * stranger can reach and every one of these is short enough to look obviously
 * right while being wrong (ADR-065).
 */

/** `rgpk_` — publishable, and named so nobody mistakes it for `rag_`, which is not. */
export const WIDGET_KEY_PREFIX = "rgpk_"

export function generateWidgetKey(): string {
	return `${WIDGET_KEY_PREFIX}${randomBytes(18).toString("base64url")}`
}

export function isWidgetKey(value: string): boolean {
	return (
		value.startsWith(WIDGET_KEY_PREFIX) &&
		value.length >= WIDGET_KEY_PREFIX.length + 20 &&
		value.length <= 120
	)
}

/**
 * Whether a request came from a page the widget is allowed on.
 *
 * **Exact origin match, never a suffix.** `endsWith("example.com")` also accepts
 * `notexample.com` and `example.com.evil.net`, which is the classic version of
 * this bug. A subdomain wildcard is offered explicitly as `*.example.com` and is
 * matched by taking the label boundary into account rather than by a substring.
 *
 * An empty allowlist accepts nothing. A widget with no origins is one nobody has
 * finished configuring, and defaulting that to "anywhere" would be the wrong way
 * round for a public endpoint that spends money.
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
	if (!origin || allowed.length === 0) return false

	let candidate: URL
	try {
		candidate = new URL(origin)
	} catch {
		return false
	}
	// `Origin` is a scheme, host and port and nothing else. Anything carrying a
	// path is not one, and treating it as one invites a parser disagreement.
	if (candidate.pathname !== "/" && candidate.pathname !== "") return false

	const normalised = `${candidate.protocol}//${candidate.host}`.toLowerCase()

	return allowed.some((entry) => {
		const pattern = entry.trim().toLowerCase().replace(/\/$/, "")
		if (!pattern) return false
		if (pattern === normalised) return true

		if (pattern.includes("://*.")) {
			const [scheme, rest] = pattern.split("://*.")
			if (!scheme || !rest) return false
			// A label boundary, so `*.example.com` accepts `shop.example.com` and
			// refuses `notexample.com` and `example.com.evil.net`.
			return (
				candidate.protocol === `${scheme}:` &&
				(candidate.host.toLowerCase() === rest ||
					candidate.host.toLowerCase().endsWith(`.${rest}`))
			)
		}

		return false
	})
}

/**
 * A visitor's identity: signed by us, held by their browser, meaningless to
 * anybody else.
 *
 * It exists so a conversation survives a page reload without an account. It
 * proves nothing about who somebody is and grants nothing — it only says "this
 * is the same browser as before", which is what a conversation needs and all it
 * needs.
 *
 * Signed rather than random so the server can read the widget it belongs to
 * without a lookup, and so a token minted for one widget cannot be presented to
 * another.
 */
export interface VisitorToken {
	widgetId: string
	visitorId: string
	issuedAt: number
}

export function signVisitorToken(token: VisitorToken, secret: string): string {
	const payload = Buffer.from(JSON.stringify(token)).toString("base64url")
	return `${payload}.${sign(payload, secret)}`
}

export function readVisitorToken(
	value: string | undefined,
	secret: string,
	maxAgeMs: number,
): VisitorToken | undefined {
	if (!value) return undefined

	const [payload, signature] = value.split(".")
	if (!payload || !signature) return undefined

	const expected = sign(payload, secret)
	const a = Buffer.from(signature)
	const b = Buffer.from(expected)
	if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined

	try {
		const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as VisitorToken
		if (typeof parsed.widgetId !== "string" || typeof parsed.visitorId !== "string") {
			return undefined
		}
		// An old token is treated as no token rather than as an error: the visitor
		// simply starts a new conversation, which is what somebody returning after
		// a month expects anyway.
		if (Date.now() - parsed.issuedAt > maxAgeMs) return undefined
		return parsed
	} catch {
		return undefined
	}
}

export function newVisitorId(): string {
	return randomBytes(16).toString("base64url")
}

function sign(payload: string, secret: string): string {
	return createHmac("sha256", secret).update(payload).digest("base64url")
}
