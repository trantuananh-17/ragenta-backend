import { Hono } from "hono"
import { cors } from "hono/cors"

import { auth } from "../auth/auth"
import { env } from "../config/env"
import { checkDatabaseConnection } from "../db/client"
import { checkStorage, isStorageConfigured } from "../storage/objects"
import { checkVectorStore, isVectorStoreConfigured } from "../vector/qdrant"
import { accountRoutes } from "../modules/account/account.routes"
import { adminRoutes } from "../modules/admin/admin.routes"
import { attachmentRoutes } from "../modules/attachment/attachment.routes"
import { billingRoutes } from "../modules/billing/billing.routes"
import { agentRoutes } from "../modules/agent/agent.routes"
import { chatRoutes } from "../modules/chat/chat.routes"
import { connectionRoutes } from "../modules/integration/connection.routes"
import { webhookEndpointRoutes } from "../modules/webhook/webhook.routes"
import { knowledgeRoutes } from "../modules/knowledge/knowledge.routes"
import { planRoutes } from "../modules/billing/plan.routes"
import { webhookRoutes } from "../modules/billing/webhook.routes"
import { publicApiRoutes } from "../modules/apikey/public.routes"
import { widgetRoutes } from "../modules/widget/widget.routes"
import { oauthCallbackRoutes } from "../modules/oauth/oauth.routes"
import { hookRoutes } from "../modules/trigger/trigger.routes"
import { modelRoutes } from "../modules/model/model.routes"
import { projectRoutes } from "../modules/project/project.routes"
import { promoRoutes } from "../modules/promo/promo.routes"
import { speechRoutes } from "../modules/speech/speech.routes"
import { usageRoutes } from "../modules/usage/usage.routes"
import { workspaceRoutes } from "../modules/workspace/workspace.routes"
import { errorHandler } from "./middleware/error-handler"
import { buildOpenApiDocument, docsPage } from "./openapi"
import { rateLimit } from "./middleware/rate-limit"
import { requestContext } from "./middleware/request-context"
import { attachSession } from "./middleware/session"
import type { AppEnv } from "./types"

/**
 * Deliberately localhost only. Staging and production are sibling hostnames
 * under one registrable domain — staging-frontend.ragenta.cloud next to
 * frontend.ragenta.cloud — so a `*.ragenta.cloud` default would let a page
 * served by one environment make credentialed calls to the other. Every
 * deployed origin is listed explicitly in TRUSTED_ORIGINS instead.
 */
const DEFAULT_ORIGINS = ["http://localhost:*", "https://localhost:*"]

function wildcardToRegex(pattern: string) {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
	return new RegExp(`^${escaped.replace(/\*/g, "[^/]*")}$`)
}

const ALLOWED_ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...env.trustedOrigins])].map(
	wildcardToRegex,
)

export function createApp() {
	const app = new Hono<AppEnv>()

	app.onError(errorHandler)
	app.use("*", requestContext)
	app.use(
		"*",
		cors({
			origin: (origin) =>
				ALLOWED_ORIGINS.some((pattern) => pattern.test(origin)) ? origin : null,
			allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
			allowHeaders: ["Content-Type", "Authorization", "x-request-id"],
			credentials: true,
		}),
	)

	/**
	 * Only the database decides the status code. Qdrant and object storage are
	 * reported because an operator needs to see them, but a vector store that is
	 * down must not take the container out of rotation — sign-in, billing and
	 * every workspace screen still work, and restarting the API would not bring
	 * Qdrant back.
	 */
	app.get("/health", async (c) => {
		const [database, vectors, storage] = await Promise.all([
			checkDatabaseConnection(),
			checkVectorStore(),
			checkStorage(),
		])
		return c.json(
			{
				status: database ? "ok" : "degraded",
				database,
				vectors: isVectorStoreConfigured() ? vectors : "not_configured",
				storage: isStorageConfigured() ? storage : "not_configured",
				time: new Date().toISOString(),
			},
			database ? 200 : 503,
		)
	})

	/**
	 * Only the paths where the request is an attempt at a credential, counted by
	 * address because the identity is the thing being guessed.
	 *
	 * Not `/v1/auth/*`: `get-session` runs on every page load of both frontends,
	 * so a window wide enough for a person with several tabs open is a window too
	 * wide to stop anything, and one narrow enough to stop something signs that
	 * person out mid-session. Better Auth applies its own limits underneath these.
	 *
	 * Registered before the mount below, because Hono applies middleware only to
	 * handlers added after it.
	 */
	const credentialAttempts = rateLimit({
		name: "auth",
		limit: 20,
		windowSeconds: 300,
		message: "Too many attempts from this address. Wait a few minutes and try again.",
	})

	for (const path of [
		"/v1/auth/sign-in/*",
		"/v1/auth/sign-up/*",
		"/v1/auth/request-password-reset",
		"/v1/auth/forget-password",
		"/v1/auth/reset-password",
	]) {
		app.use(path, credentialAttempts)
	}

	// Better Auth owns everything under its own base path and manages its own
	// session handling, so it is mounted before our session middleware.
	app.on(["GET", "POST"], "/v1/auth/*", (c) => auth.handler(c.req.raw))

	// Before attachSession: the caller is Stripe, not a session, and the request
	// is authenticated by its signature instead.
	app.route("/v1/webhooks", webhookRoutes)
	// Inbound webhooks that start an agent. Public by design — see hookRoutes.
	app.route("/v1/hooks", hookRoutes)

	// Registered before the module routers below, which is what makes it run for
	// them: Hono applies middleware to handlers added after it.
	app.use("/v1/*", attachSession)

	app.route("/v1/me", accountRoutes)
	app.route("/v1/plans", planRoutes)
	app.route("/v1/workspaces", workspaceRoutes)
	app.route("/v1/workspaces", projectRoutes)
	app.route("/v1/workspaces", billingRoutes)
	app.route("/v1/workspaces", usageRoutes)
	app.route("/v1/workspaces", modelRoutes)
	app.route("/v1/workspaces", promoRoutes)
	app.route("/v1/workspaces", knowledgeRoutes)
	app.route("/v1/workspaces", chatRoutes)
	app.route("/v1/workspaces", attachmentRoutes)
	app.route("/v1/workspaces", speechRoutes)
	app.route("/v1/workspaces", agentRoutes)
	app.route("/v1/workspaces", connectionRoutes)
	// Outbound: where a workspace asks to be told about things. Distinct from the
	// Stripe router mounted at /v1/webhooks above, which is inbound.
	app.route("/v1/workspaces", webhookEndpointRoutes)
	// Embedded chat, talked to by strangers on other people's websites. It brings
	// its own CORS because the origins are not known at build time.
	app.route("/v1/widget", widgetRoutes)
	// The developer API: authenticated by an API key, deliberately small.
	app.route("/v1/api", publicApiRoutes)
	// The provider redirects a browser here; the workspace comes from the state.
	app.route("/v1/oauth", oauthCallbackRoutes)
	app.route("/v1/admin", adminRoutes)

	// Registered last so the document sees every route above it. Off in
	// production unless DOCS_ENABLED says otherwise.
	if (env.docsEnabled) {
		let document: unknown

		app.get("/v1/openapi.json", async (c) => {
			document ??= await buildOpenApiDocument(app)
			return c.json(document)
		})
		app.get("/v1/docs", (c) => c.html(docsPage))
	}

	app.notFound((c) =>
		c.json(
			{
				error: { code: "NOT_FOUND", message: "No route matches this request." },
				requestId: c.get("requestId") ?? "unknown",
			},
			404,
		),
	)

	return app
}
