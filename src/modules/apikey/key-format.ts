import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * What an API key looks like, and how one is recognised.
 *
 * Alone and tested, for the reason `client-address.ts` and `primary-role.ts` are:
 * it is short enough to look obviously correct and every way of getting it wrong
 * either accepts something it should not or leaks how close a guess was.
 */

/**
 * A visible prefix, deliberately.
 *
 * It costs nothing and it is what lets a secret scanner — GitHub's, or a
 * customer's own — recognise a leaked Ragenta key in a commit and tell somebody.
 * A key that looks like any other random string is one nobody notices in a
 * public repository until it is used.
 */
export const KEY_PREFIX = "rag_"

export interface GeneratedKey {
	/** Shown once, at creation, and never stored. */
	plaintext: string
	hash: string
	hint: string
}

export function generateKey(): GeneratedKey {
	const plaintext = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`
	return { plaintext, hash: hashKey(plaintext), hint: hintFor(plaintext) }
}

/**
 * SHA-256, no work factor, and that is the right call here.
 *
 * A password needs one because people choose passwords a dictionary contains.
 * This is 32 random bytes we generated — there is nothing to run a dictionary
 * against — and a slow hash would be paid on **every authenticated request**
 * rather than once at sign-in. Bcrypt on the hot path is how an API becomes slow
 * for no security gain.
 */
export function hashKey(plaintext: string): string {
	return createHash("sha256").update(plaintext).digest("hex")
}

export function keysMatch(presented: string, storedHash: string): boolean {
	const a = Buffer.from(hashKey(presented), "hex")
	const b = Buffer.from(storedHash, "hex")
	// Constant time, so the number of matching leading bytes is not observable —
	// which matters more here than for a password, because a caller may present
	// as many guesses as the rate limiter allows.
	return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The only part of a key that survives creation in a readable form.
 *
 * Both ends, because that is how somebody matches a key on a screen against one
 * pasted into a config file they can see the end of. Never enough to reconstruct.
 */
export function hintFor(plaintext: string): string {
	const body = plaintext.slice(KEY_PREFIX.length)
	return `${KEY_PREFIX}${body.slice(0, 4)}…${body.slice(-4)}`
}

/**
 * The key a request presented, or nothing.
 *
 * `Authorization: Bearer rag_…` only. A key in a query string ends up in access
 * logs, in browser history and in the `Referer` header of every link on the page
 * it loaded, so one arriving there is refused rather than accepted with a
 * warning nobody reads.
 */
export function keyFromHeader(header: string | undefined): string | undefined {
	if (!header) return undefined

	const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
	const token = match?.[1]
	if (!token || !token.startsWith(KEY_PREFIX)) return undefined

	// A plausible length, checked before the database is touched: an obviously
	// wrong token should cost a string comparison, not a query.
	if (token.length < KEY_PREFIX.length + 32 || token.length > 200) return undefined

	return token
}
