import { env } from "../config/env"

type Level = "debug" | "info" | "warn" | "error"
type Fields = Record<string, unknown>

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MIN_LEVEL = env.isProduction ? LEVEL_ORDER.info : LEVEL_ORDER.debug

/**
 * Keys that must never reach a log line, whatever the caller passes. Billing and
 * auth code handles all of these, and a structured logger makes it far too easy
 * to spread an object containing one.
 */
const REDACTED_KEYS = new Set([
	"password",
	"token",
	"accessToken",
	"refreshToken",
	"idToken",
	"secret",
	"clientSecret",
	"apiKey",
	"authorization",
	"cookie",
])

function redact(fields: Fields): Fields {
	const safe: Fields = {}
	for (const [key, value] of Object.entries(fields)) {
		safe[key] = REDACTED_KEYS.has(key) ? "[redacted]" : value
	}
	return safe
}

function serializeError(error: unknown) {
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack }
	}
	return { message: String(error) }
}

export interface Logger {
	debug(message: string, fields?: Fields): void
	info(message: string, fields?: Fields): void
	warn(message: string, fields?: Fields): void
	error(message: string, error?: unknown, fields?: Fields): void
	child(bindings: Fields): Logger
}

function create(bindings: Fields): Logger {
	function write(level: Level, message: string, fields?: Fields) {
		if (LEVEL_ORDER[level] < MIN_LEVEL) return
		const line = JSON.stringify({
			level,
			time: new Date().toISOString(),
			message,
			...redact(bindings),
			...redact(fields ?? {}),
		})
		if (level === "error" || level === "warn") console.error(line)
		else console.log(line)
	}

	return {
		debug: (message, fields) => write("debug", message, fields),
		info: (message, fields) => write("info", message, fields),
		warn: (message, fields) => write("warn", message, fields),
		error: (message, error, fields) =>
			write("error", message, { ...fields, err: error ? serializeError(error) : undefined }),
		child: (extra) => create({ ...bindings, ...extra }),
	}
}

export const logger = create({})
