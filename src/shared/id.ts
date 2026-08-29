import { randomUUID } from "node:crypto"

/**
 * All primary keys are text so they stay compatible with the ids Better Auth
 * generates for its own tables.
 */
export function newId(): string {
	return randomUUID()
}

/** `YYYY-MM` in UTC — the period key monthly credit refills are idempotent on. */
export function monthKey(date = new Date()): string {
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
}
