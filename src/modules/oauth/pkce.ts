import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * PKCE, and the state that binds an authorization back to who started it.
 *
 * Alone in its own module and tested, because this is the part of an OAuth flow
 * that is short enough to look obviously right and is where the two classic
 * holes live:
 *
 *  - **A state that is not bound to the session** lets an attacker complete
 *    their own authorization in somebody else's browser, attaching their account
 *    to the victim's workspace. Login CSRF, with a token that then gets used by
 *    the victim's agents.
 *  - **A verifier that is not checked** makes an intercepted authorization code
 *    redeemable by whoever intercepted it.
 *
 * `S256`, never `plain`. The `plain` method exists for clients that cannot hash,
 * which is not this one, and it reduces the verifier to a bearer secret sent in
 * the clear on the first leg.
 */

export interface PkcePair {
	verifier: string
	challenge: string
	method: "S256"
}

export function createPkcePair(): PkcePair {
	// 43–128 characters of unreserved alphabet, per RFC 7636. 32 random bytes
	// base64url-encoded is 43, the shortest the spec allows and already 256 bits.
	const verifier = randomBytes(32).toString("base64url")
	const challenge = createHash("sha256").update(verifier).digest("base64url")
	return { verifier, challenge, method: "S256" }
}

/** What is remembered between the redirect out and the callback back. */
export interface OAuthState {
	state: string
	verifier: string
	workspaceId: string
	/** Who started it. The callback must be completed by the same person. */
	userId: string
	provider: string
	/** Where to send the browser afterwards, validated against an allowlist. */
	returnTo: string
}

export function createState(): string {
	return randomBytes(32).toString("base64url")
}

/**
 * Whether a callback may be completed by this caller.
 *
 * Both halves matter. The provider has to match, or a code issued by one
 * provider could be redeemed at another's token endpoint; and the **user** has
 * to match, which is the check that turns a stolen state parameter into nothing.
 * Compared in constant time so neither is a timing oracle.
 */
export function stateBelongsTo(
	stored: OAuthState,
	provider: string,
	userId: string,
): boolean {
	return equal(stored.provider, provider) && equal(stored.userId, userId)
}

function equal(a: string, b: string): boolean {
	const left = Buffer.from(a)
	const right = Buffer.from(b)
	return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Where the browser may be sent after a callback.
 *
 * An open redirect on this endpoint is worth more than a normal one: the URL is
 * reached the instant an authorization succeeds, so it is the natural place to
 * bounce somebody to a page that looks like the product and asks for a password.
 * Only a path on our own app is accepted — never a full URL, never a
 * protocol-relative one, and never a backslash, which some parsers read as a
 * separator and some do not.
 */
export function safeReturnTo(value: string | undefined, fallback: string): string {
	if (!value) return fallback
	if (!value.startsWith("/")) return fallback
	// `//host` is protocol-relative and leaves the site; `/\host` is the same
	// thing to a parser that normalises backslashes.
	if (value.startsWith("//") || value.startsWith("/\\")) return fallback
	if (value.includes("\\")) return fallback
	if (value.includes("://")) return fallback
	return value
}
