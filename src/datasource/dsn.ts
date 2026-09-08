/**
 * Reading and masking a connection string.
 *
 * Alone and tested, because it is the piece that decides whether a password ends
 * up on a screen, in an error message or in a log line — and it is short enough
 * to look obviously right while being wrong about one of the three.
 */

export type DataSourceEngine = "postgres" | "mysql"

export interface ParsedDsn {
	engine: DataSourceEngine
	host: string
	database: string
	user: string
}

const ENGINES: Record<string, DataSourceEngine> = {
	"postgres:": "postgres",
	"postgresql:": "postgres",
	"mysql:": "mysql",
}

export function parseDsn(dsn: string): ParsedDsn | undefined {
	let url: URL
	try {
		url = new URL(dsn.trim())
	} catch {
		return undefined
	}

	const engine = ENGINES[url.protocol]
	if (!engine) return undefined
	if (!url.hostname) return undefined

	const database = url.pathname.replace(/^\//, "")
	if (!database) return undefined

	return { engine, host: url.host, database, user: decodeURIComponent(url.username) }
}

/**
 * The connection string as it may be shown.
 *
 * The password is replaced, never shortened: a masked-but-partial password is a
 * head start. Everything else stays, because "which database is this" is exactly
 * what somebody looking at the screen needs to know.
 */
export function maskDsn(dsn: string): string {
	const parsed = parseDsn(dsn)
	if (!parsed) return "(unreadable connection string)"

	const user = parsed.user ? `${parsed.user}@` : ""
	return `${parsed.engine}://${user}${parsed.host}/${parsed.database}`
}

/**
 * Whether a string could carry a credential.
 *
 * Used to keep one out of a log or an error. Deliberately generous about what
 * counts: a false positive costs a redacted log line, a false negative costs a
 * password in a file somebody keeps for a year.
 */
export function looksLikeDsn(value: string): boolean {
	return /\b(postgres|postgresql|mysql):\/\/[^\s]*:[^\s@]*@/i.test(value)
}

/** Replaces any credential-bearing URL inside arbitrary text. */
export function scrubDsns(text: string): string {
	return text.replace(/(\b(?:postgres|postgresql|mysql):\/\/[^:\s]+):[^@\s]+@/gi, "$1:***@")
}
