import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto"
import { createHash } from "node:crypto"

import { env } from "../config/env"
import { AppError } from "./errors"

/**
 * Symmetric encryption for secrets Ragenta has to be able to read back — right
 * now, the provider API keys it calls with.
 *
 * AES-256-GCM, so the ciphertext is authenticated: a row someone edited by hand
 * fails to decrypt instead of producing a different key. The stored form is
 * `v1.<iv>.<tag>.<ciphertext>`, all base64url, with the version leading so a
 * future algorithm change can read old rows.
 *
 * This is NOT for passwords or API keys Ragenta issues — those are hashed and
 * never read back. Encryption is only correct when the plaintext is needed
 * again.
 */
const VERSION = "v1"
const ALGORITHM = "aes-256-gcm"
const IV_BYTES = 12

export class EncryptionUnavailableError extends AppError {
	constructor() {
		super(
			"ENCRYPTION_UNAVAILABLE",
			"SECRETS_ENCRYPTION_KEY is not configured, so this deployment cannot store provider credentials.",
			503,
		)
	}
}

function key(): Buffer {
	if (!env.secretsEncryptionKey) throw new EncryptionUnavailableError()
	return env.secretsEncryptionKey
}

export function isEncryptionConfigured(): boolean {
	return env.secretsEncryptionKey !== undefined
}

export function encryptSecret(plaintext: string): string {
	const iv = randomBytes(IV_BYTES)
	const cipher = createCipheriv(ALGORITHM, key(), iv)
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
	return [
		VERSION,
		iv.toString("base64url"),
		cipher.getAuthTag().toString("base64url"),
		ciphertext.toString("base64url"),
	].join(".")
}

export function decryptSecret(stored: string): string {
	const [version, iv, tag, ciphertext] = stored.split(".")
	if (version !== VERSION || !iv || !tag || !ciphertext) {
		throw new Error("Stored secret is not in the expected format.")
	}

	const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, "base64url"))
	decipher.setAuthTag(Buffer.from(tag, "base64url"))
	return Buffer.concat([
		decipher.update(Buffer.from(ciphertext, "base64url")),
		decipher.final(),
	]).toString("utf8")
}

/**
 * What a screen is allowed to see: enough of the key to tell two apart, never
 * enough to use one. Short keys are masked entirely rather than half-revealed.
 */
export function maskSecret(plaintext: string): string {
	const trimmed = plaintext.trim()
	if (trimmed.length <= 8) return "••••"
	return `${trimmed.slice(0, 3)}••••${trimmed.slice(-4)}`
}

/** Constant-time comparison, for anything derived from a caller-supplied value. */
export function safeEqual(a: string, b: string): boolean {
	const left = createHash("sha256").update(a).digest()
	const right = createHash("sha256").update(b).digest()
	return timingSafeEqual(left, right)
}
