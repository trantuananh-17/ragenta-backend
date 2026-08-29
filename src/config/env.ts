import "dotenv/config"
import { z } from "zod"

/**
 * The only place in the codebase that reads `process.env`. Both the API and the
 * worker import this module, so a missing or malformed variable fails at
 * startup with a readable message instead of surfacing as a null deref hours
 * later inside a request or a job.
 */
const envSchema = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
	PORT: z.coerce.number().int().positive().default(8080),

	API_BASE_URL: z.url(),
	APP_BASE_URL: z.url(),
	TRUSTED_ORIGINS: z.string().default(""),

	BETTER_AUTH_SECRET: z.string().min(32),
	AUTH_COOKIE_DOMAIN: z.string().optional(),
	GOOGLE_CLIENT_ID: z.string().optional(),
	GOOGLE_CLIENT_SECRET: z.string().optional(),

	DATABASE_URL: z.string().min(1),
	REDIS_URL: z.string().min(1),

	SMTP_HOST: z.string().optional(),
	SMTP_PORT: z.coerce.number().int().positive().default(587),
	SMTP_USER: z.string().optional(),
	SMTP_PASSWORD: z.string().optional(),
	SMTP_FROM_EMAIL: z.string().default("no-reply@ragenta.com"),
	SMTP_FROM_NAME: z.string().default("Ragenta"),

	ADMIN_USER_IDS: z.string().default(""),

	/** Serve /v1/docs. Defaults to on outside production. */
	DOCS_ENABLED: z.enum(["true", "false"]).optional(),
})

function parseEnv() {
	const parsed = envSchema.safeParse(process.env)
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
			.join("\n")
		throw new Error(`Invalid environment configuration:\n${issues}`)
	}
	return parsed.data
}

const raw = parseEnv()

function splitList(value: string) {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
}

/**
 * A cookie Domain attribute cannot be a loopback host, and setting one on
 * localhost silently breaks sign-in in development.
 */
function cookieDomain() {
	const domain = raw.AUTH_COOKIE_DOMAIN?.trim()
	if (!domain || domain === "localhost" || domain === "127.0.0.1" || domain === "::1") {
		return undefined
	}
	return domain
}

export const env = {
	nodeEnv: raw.NODE_ENV,
	isProduction: raw.NODE_ENV === "production",
	port: raw.PORT,

	apiBaseUrl: raw.API_BASE_URL,
	appBaseUrl: raw.APP_BASE_URL,
	trustedOrigins: splitList(raw.TRUSTED_ORIGINS),

	auth: {
		secret: raw.BETTER_AUTH_SECRET,
		cookieDomain: cookieDomain(),
		google:
			raw.GOOGLE_CLIENT_ID && raw.GOOGLE_CLIENT_SECRET
				? { clientId: raw.GOOGLE_CLIENT_ID, clientSecret: raw.GOOGLE_CLIENT_SECRET }
				: undefined,
	},

	databaseUrl: raw.DATABASE_URL,
	redisUrl: raw.REDIS_URL,

	smtp: raw.SMTP_HOST
		? {
				host: raw.SMTP_HOST,
				port: raw.SMTP_PORT,
				user: raw.SMTP_USER,
				password: raw.SMTP_PASSWORD,
				from: `"${raw.SMTP_FROM_NAME}" <${raw.SMTP_FROM_EMAIL}>`,
			}
		: undefined,

	adminUserIds: splitList(raw.ADMIN_USER_IDS),

	docsEnabled: raw.DOCS_ENABLED ? raw.DOCS_ENABLED === "true" : raw.NODE_ENV !== "production",
} as const

export type Env = typeof env
