import "dotenv/config"
import { Buffer } from "node:buffer"
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
	/**
	 * Namespaces this environment's cookie names. Required whenever
	 * AUTH_COOKIE_DOMAIN is set, because the only Domain value that spans one
	 * environment's hostnames spans the other's too — see cookiePrefix() below.
	 */
	AUTH_COOKIE_PREFIX: z.string().optional(),
	GOOGLE_CLIENT_ID: z.string().optional(),
	GOOGLE_CLIENT_SECRET: z.string().optional(),

	DATABASE_URL: z.string().min(1),
	REDIS_URL: z.string().min(1),

	/**
	 * Vector store for retrieval. Optional so an environment that only runs the
	 * API and billing does not need one; knowledge-base endpoints refuse when it
	 * is unset rather than failing halfway through an ingestion.
	 */
	QDRANT_URL: z.url().optional(),
	QDRANT_API_KEY: z.string().optional(),

	/** S3-compatible object storage for uploaded documents (MinIO in every environment so far). */
	STORAGE_ENDPOINT: z.string().optional(),
	STORAGE_PORT: z.coerce.number().int().positive().default(9000),
	STORAGE_USE_SSL: z.enum(["true", "false"]).default("false"),
	STORAGE_ACCESS_KEY: z.string().optional(),
	STORAGE_SECRET_KEY: z.string().optional(),
	STORAGE_BUCKET: z.string().default("ragenta-documents"),
	STORAGE_REGION: z.string().default("us-east-1"),

	/**
	 * 32 bytes, base64. Encrypts provider API keys at rest. Without it the
	 * platform still runs on the environment-variable keys below, but storing a
	 * credential through the admin API is refused — writing a secret in the clear
	 * because a key was missing is never the safer fallback.
	 *
	 * Generate with: openssl rand -base64 32
	 */
	SECRETS_ENCRYPTION_KEY: z.string().optional(),

	/**
	 * Ragenta pays for inference, so provider keys are server secrets. A provider
	 * without a key here is simply not offered — see src/ai/providers.ts.
	 */
	OPENAI_API_KEY: z.string().optional(),
	ANTHROPIC_API_KEY: z.string().optional(),
	GOOGLE_API_KEY: z.string().optional(),

	/**
	 * Stripe. Both the key and the webhook secret must be present or the payment
	 * surface stays off — a deployment that can charge cards but cannot verify
	 * the webhooks confirming those charges is worse than one that cannot charge.
	 */
	STRIPE_SECRET_KEY: z.string().optional(),
	STRIPE_WEBHOOK_SECRET: z.string().optional(),
	STRIPE_PRICE_PRO: z.string().optional(),
	STRIPE_PRICE_TEAM: z.string().optional(),
	STRIPE_PRICE_TOPUP_1M: z.string().optional(),
	STRIPE_PRICE_TOPUP_5M: z.string().optional(),
	STRIPE_PRICE_TOPUP_15M: z.string().optional(),

	SMTP_HOST: z.string().optional(),
	SMTP_PORT: z.coerce.number().int().positive().default(587),
	SMTP_USER: z.string().optional(),
	SMTP_PASSWORD: z.string().optional(),
	SMTP_FROM_EMAIL: z.string().default("no-reply@ragenta.cloud"),
	SMTP_FROM_NAME: z.string().default("Ragenta"),

	ADMIN_USER_IDS: z.string().default(""),

	/** Serve /v1/docs. Defaults to on outside production. */
	DOCS_ENABLED: z.enum(["true", "false"]).optional(),
})

/**
 * Decoded once at startup so a malformed key is a boot failure with a readable
 * message, not a decrypt error the first time somebody opens the models screen.
 */
function encryptionKey(): Buffer | undefined {
	const value = raw.SECRETS_ENCRYPTION_KEY?.trim()
	if (!value) return undefined
	const decoded = Buffer.from(value, "base64")
	if (decoded.length !== 32) {
		throw new Error(
			`SECRETS_ENCRYPTION_KEY must be 32 bytes of base64, got ${decoded.length}. Generate with: openssl rand -base64 32`,
		)
	}
	return decoded
}

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

/**
 * Cookie names are what keep two environments apart once they share a Domain.
 *
 * Staging and production live under one registrable domain, so the only Domain
 * value that reaches every staging hostname reaches production's as well
 * (ADR-022). The browser will therefore offer this environment's cookies to the
 * other one's hosts; distinct names are what make that harmless, because a
 * session token is only read under the name its own environment issued.
 *
 * Refusing to start is deliberate. Sharing a Domain with a shared prefix looks
 * like it works — right up to the moment signing in to staging silently
 * replaces a production session under the same cookie name.
 */
function cookiePrefix() {
	const prefix = raw.AUTH_COOKIE_PREFIX?.trim()
	if (cookieDomain() && !prefix) {
		throw new Error(
			"Invalid environment configuration:\n" +
				"  AUTH_COOKIE_PREFIX: required when AUTH_COOKIE_DOMAIN is set, so this " +
				"environment's cookies cannot collide with another environment's under the " +
				"shared domain.",
		)
	}
	return prefix || undefined
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
		cookiePrefix: cookiePrefix(),
		google:
			raw.GOOGLE_CLIENT_ID && raw.GOOGLE_CLIENT_SECRET
				? { clientId: raw.GOOGLE_CLIENT_ID, clientSecret: raw.GOOGLE_CLIENT_SECRET }
				: undefined,
	},

	databaseUrl: raw.DATABASE_URL,
	redisUrl: raw.REDIS_URL,

	qdrant: raw.QDRANT_URL
		? { url: raw.QDRANT_URL, apiKey: raw.QDRANT_API_KEY || undefined }
		: undefined,

	storage:
		raw.STORAGE_ENDPOINT && raw.STORAGE_ACCESS_KEY && raw.STORAGE_SECRET_KEY
			? {
					endPoint: raw.STORAGE_ENDPOINT,
					port: raw.STORAGE_PORT,
					useSSL: raw.STORAGE_USE_SSL === "true",
					accessKey: raw.STORAGE_ACCESS_KEY,
					secretKey: raw.STORAGE_SECRET_KEY,
					bucket: raw.STORAGE_BUCKET,
					region: raw.STORAGE_REGION,
				}
			: undefined,

	secretsEncryptionKey: encryptionKey(),

	stripe:
		raw.STRIPE_SECRET_KEY && raw.STRIPE_WEBHOOK_SECRET
			? {
					secretKey: raw.STRIPE_SECRET_KEY,
					webhookSecret: raw.STRIPE_WEBHOOK_SECRET,
					prices: {
						pro: raw.STRIPE_PRICE_PRO,
						team: raw.STRIPE_PRICE_TEAM,
						topup1m: raw.STRIPE_PRICE_TOPUP_1M,
						topup5m: raw.STRIPE_PRICE_TOPUP_5M,
						topup15m: raw.STRIPE_PRICE_TOPUP_15M,
					},
				}
			: undefined,

	providerKeys: {
		openai: raw.OPENAI_API_KEY,
		anthropic: raw.ANTHROPIC_API_KEY,
		google: raw.GOOGLE_API_KEY,
	},

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
