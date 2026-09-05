import { Hono } from "hono"
import { cors } from "hono/cors"

import { auth } from "../auth/auth"
import { env } from "../config/env"
import { checkDatabaseConnection } from "../db/client"
import { checkStorage, isStorageConfigured } from "../storage/objects"
import { checkVectorStore, isVectorStoreConfigured } from "../vector/qdrant"
import { accountRoutes } from "../modules/account/account.routes"
import { adminRoutes } from "../modules/admin/admin.routes"
import { billingRoutes } from "../modules/billing/billing.routes"
import { chatRoutes } from "../modules/chat/chat.routes"
import { knowledgeRoutes } from "../modules/knowledge/knowledge.routes"
import { planRoutes } from "../modules/billing/plan.routes"
import { webhookRoutes } from "../modules/billing/webhook.routes"
import { modelRoutes } from "../modules/model/model.routes"
import { projectRoutes } from "../modules/project/project.routes"
import { promoRoutes } from "../modules/promo/promo.routes"
import { usageRoutes } from "../modules/usage/usage.routes"
import { workspaceRoutes } from "../modules/workspace/workspace.routes"
import { errorHandler } from "./middleware/error-handler"
import { buildOpenApiDocument, docsPage } from "./openapi"
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

	// Better Auth owns everything under its own base path and manages its own
	// session handling, so it is mounted before our session middleware.
	app.on(["GET", "POST"], "/v1/auth/*", (c) => auth.handler(c.req.raw))

	// Before attachSession: the caller is Stripe, not a session, and the request
	// is authenticated by its signature instead.
	app.route("/v1/webhooks", webhookRoutes)

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
