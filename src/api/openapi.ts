import type { Hono } from "hono"
import { z } from "zod"

import { auth } from "../auth/auth"
import { env } from "../config/env"
import { adjustCreditsSchema, adminListQuerySchema, setPlanSchema } from "../modules/admin/admin.dto"
import { createCheckoutSchema, updateAutoReloadSchema } from "../modules/billing/billing.dto"
import {
	createConversationSchema,
	sendMessageSchema,
	updateConversationSchema,
} from "../modules/chat/chat.dto"
import {
	createKnowledgeBaseSchema,
	updateKnowledgeBaseSchema,
} from "../modules/knowledge/knowledge.dto"
import { updateModelSettingsSchema } from "../modules/model/model.dto"
import {
	patchModelSchema,
	saveCredentialSchema,
	setPlatformDefaultsSchema,
	upsertModelSchema,
} from "../modules/provider/provider.dto"
import {
	createPromoCodeSchema,
	listPromoCodesQuerySchema,
	redeemPromoCodeSchema,
	updatePromoCodeSchema,
} from "../modules/promo/promo.dto"
import {
	createProjectSchema,
	listProjectsQuerySchema,
	updateProjectSchema,
} from "../modules/project/project.dto"
import {
	createWorkspaceSchema,
	inviteMemberSchema,
	updateMemberRoleSchema,
	updateWorkspaceSchema,
} from "../modules/workspace/workspace.dto"
import { paginationQuerySchema } from "../shared/pagination"
import { logger } from "../shared/logger"
import type { AppEnv } from "./types"

interface RouteMeta {
	summary: string
	tags: string[]
	/** Roles the route requires, shown in the description. */
	access?: string
	body?: z.ZodType
	query?: z.ZodType
	status?: number
}

/**
 * Descriptions for the routes the app actually registers, keyed by
 * `METHOD /path`.
 *
 * The path list is NOT written here — it is read from the Hono router at build
 * time, so a route added without an entry below still shows up in the document
 * (undescribed) instead of silently missing from the docs.
 */
const ROUTE_DOCS: Record<string, RouteMeta> = {
	"GET /health": { summary: "Liveness and database check", tags: ["System"] },
	"GET /v1/docs": { summary: "This page", tags: ["System"] },
	"GET /v1/openapi.json": { summary: "This document", tags: ["System"] },

	"GET /v1/me": { summary: "Current user and active workspace", tags: ["Account"] },
	"GET /v1/me/workspaces": { summary: "Workspaces the caller belongs to", tags: ["Account"] },

	"GET /v1/plans": {
		summary: "Plan catalogue and top-up packs",
		tags: ["Billing"],
	},

	"GET /v1/workspaces": { summary: "List my workspaces", tags: ["Workspaces"] },
	"POST /v1/workspaces": {
		summary: "Create a workspace",
		tags: ["Workspaces"],
		body: createWorkspaceSchema,
		status: 201,
	},
	"GET /v1/workspaces/:workspaceId": {
		summary: "Workspace overview with plan and credits",
		tags: ["Workspaces"],
		access: "any member",
	},
	"PATCH /v1/workspaces/:workspaceId": {
		summary: "Update workspace settings",
		tags: ["Workspaces"],
		access: "owner, admin",
		body: updateWorkspaceSchema,
	},
	"GET /v1/workspaces/:workspaceId/members": {
		summary: "List members",
		tags: ["Workspaces"],
		access: "any member",
		query: paginationQuerySchema,
	},
	"PATCH /v1/workspaces/:workspaceId/members/:memberId": {
		summary: "Change a member's role",
		tags: ["Workspaces"],
		access: "owner, admin",
		body: updateMemberRoleSchema,
	},
	"DELETE /v1/workspaces/:workspaceId/members/:memberId": {
		summary: "Remove a member",
		tags: ["Workspaces"],
		access: "owner, admin",
		status: 204,
	},
	"GET /v1/workspaces/:workspaceId/invitations": {
		summary: "List pending invitations",
		tags: ["Workspaces"],
		access: "owner, admin",
	},
	"POST /v1/workspaces/:workspaceId/invitations": {
		summary: "Invite someone. Refused with SEAT_LIMIT_REACHED when the plan is full",
		tags: ["Workspaces"],
		access: "owner, admin",
		body: inviteMemberSchema,
		status: 201,
	},
	"DELETE /v1/workspaces/:workspaceId/invitations/:invitationId": {
		summary: "Cancel an invitation",
		tags: ["Workspaces"],
		access: "owner, admin",
		status: 204,
	},

	"GET /v1/workspaces/:workspaceId/projects": {
		summary: "List projects",
		tags: ["Projects"],
		access: "any member",
		query: listProjectsQuerySchema,
	},
	"POST /v1/workspaces/:workspaceId/projects": {
		summary: "Create a project",
		tags: ["Projects"],
		access: "owner, admin, member",
		body: createProjectSchema,
		status: 201,
	},
	"GET /v1/workspaces/:workspaceId/projects/:projectId": {
		summary: "Project detail",
		tags: ["Projects"],
		access: "any member",
	},
	"PATCH /v1/workspaces/:workspaceId/projects/:projectId": {
		summary: "Update a project",
		tags: ["Projects"],
		access: "owner, admin, member",
		body: updateProjectSchema,
	},
	"POST /v1/workspaces/:workspaceId/projects/:projectId/archive": {
		summary: "Archive a project (reversible, keeps usage history)",
		tags: ["Projects"],
		access: "owner, admin",
	},
	"POST /v1/workspaces/:workspaceId/projects/:projectId/restore": {
		summary: "Restore an archived project",
		tags: ["Projects"],
		access: "owner, admin",
	},
	"DELETE /v1/workspaces/:workspaceId/projects/:projectId": {
		summary: "Delete a project permanently. Must be archived first",
		tags: ["Projects"],
		access: "owner",
		status: 204,
	},

	"GET /v1/workspaces/:workspaceId/billing": {
		summary: "Plan, credit balance and seat usage",
		tags: ["Billing"],
		access: "any member",
	},
	"GET /v1/workspaces/:workspaceId/billing/transactions": {
		summary: "Credit ledger",
		tags: ["Billing"],
		access: "owner, admin",
		query: paginationQuerySchema,
	},

	"POST /v1/workspaces/:workspaceId/billing/checkout": {
		summary: "Start Stripe checkout for a plan or a top-up pack",
		tags: ["Billing"],
		access: "owner, admin",
		body: createCheckoutSchema,
		status: 200,
	},
	"POST /v1/workspaces/:workspaceId/billing/portal": {
		summary: "Open the Stripe billing portal (cards, invoices, cancellation)",
		tags: ["Billing"],
		access: "owner, admin",
		status: 200,
	},
	"GET /v1/workspaces/:workspaceId/billing/auto-reload": {
		summary: "Auto-reload settings and the last failure, if any",
		tags: ["Billing"],
		access: "owner, admin",
	},
	"PUT /v1/workspaces/:workspaceId/billing/auto-reload": {
		summary: "Enable or change auto-reload. Requires a card already on file",
		tags: ["Billing"],
		access: "owner, admin",
		body: updateAutoReloadSchema,
	},

	"POST /v1/webhooks/stripe": {
		summary:
			"Stripe webhook. Authenticated by signature, not by session — do not call directly",
		tags: ["System"],
		status: 200,
	},

	"GET /v1/workspaces/:workspaceId/usage": {
		summary: "Spend grouped by operation, provider and model",
		tags: ["Usage"],
		access: "any member",
	},
	"GET /v1/workspaces/:workspaceId/usage/records": {
		summary: "Raw usage rows with token counts",
		tags: ["Usage"],
		access: "any member",
		query: paginationQuerySchema,
	},
	"GET /v1/workspaces/:workspaceId/models": {
		summary: "Model catalogue, each entry marked configured, entitled and selectable",
		tags: ["Models"],
		access: "any member",
	},
	"GET /v1/workspaces/:workspaceId/settings/models": {
		summary: "Chat and embedding models this workspace runs",
		tags: ["Models"],
		access: "any member",
	},
	"PUT /v1/workspaces/:workspaceId/settings/models": {
		summary: "Change the workspace's default chat or embedding model",
		tags: ["Models"],
		access: "owner, admin",
		body: updateModelSettingsSchema,
	},

	"GET /v1/admin/users": {
		summary: "List all users",
		tags: ["Admin"],
		access: "platform admin",
		query: adminListQuerySchema,
	},
	"GET /v1/admin/workspaces": {
		summary: "List all workspaces with plan and balance",
		tags: ["Admin"],
		access: "platform admin",
		query: adminListQuerySchema,
	},
	"GET /v1/admin/workspaces/:workspaceId": {
		summary: "Workspace detail",
		tags: ["Admin"],
		access: "platform admin",
	},
	"POST /v1/admin/workspaces/:workspaceId/credits": {
		summary: "Signed credit adjustment. Writes the ledger and the audit trail",
		tags: ["Admin"],
		access: "platform admin",
		body: adjustCreditsSchema,
	},
	"PUT /v1/admin/workspaces/:workspaceId/plan": {
		summary: "Change a workspace's plan",
		tags: ["Admin"],
		access: "platform admin",
		body: setPlanSchema,
	},
	"GET /v1/admin/audit-log": {
		summary: "Audit trail",
		tags: ["Admin"],
		access: "platform admin",
		query: paginationQuerySchema,
	},

	"GET /v1/admin/promo-codes": {
		summary: "List promo codes, newest first",
		tags: ["Admin"],
		access: "platform admin",
		query: listPromoCodesQuerySchema,
	},
	"POST /v1/admin/promo-codes": {
		summary: "Create a promo code",
		tags: ["Admin"],
		access: "platform admin",
		body: createPromoCodeSchema,
		status: 201,
	},
	"PATCH /v1/admin/promo-codes/:promoCodeId": {
		summary: "Enable or disable a promo code — the only mutable field",
		tags: ["Admin"],
		access: "platform admin",
		body: updatePromoCodeSchema,
	},
	"DELETE /v1/admin/promo-codes/:promoCodeId": {
		summary: "Delete a code nobody redeemed. Refused with 409 once one has",
		tags: ["Admin"],
		access: "platform admin",
		status: 204,
	},
	"GET /v1/admin/promo-codes/:promoCodeId/redemptions": {
		summary: "Which workspaces redeemed a code",
		tags: ["Admin"],
		access: "platform admin",
		query: paginationQuerySchema,
	},

	"GET /v1/workspaces/:workspaceId/knowledge-bases": {
		summary: "List knowledge bases",
		tags: ["Knowledge"],
		access: "any member",
		query: paginationQuerySchema,
	},
	"POST /v1/workspaces/:workspaceId/knowledge-bases": {
		summary:
			"Create a knowledge base. Its embedding model is frozen at creation — vectors from two models are not comparable",
		tags: ["Knowledge"],
		access: "owner, admin, member",
		body: createKnowledgeBaseSchema,
		status: 201,
	},
	"GET /v1/workspaces/:workspaceId/knowledge-bases/:baseId": {
		summary: "Knowledge base detail with document and chunk counts",
		tags: ["Knowledge"],
		access: "any member",
	},
	"PATCH /v1/workspaces/:workspaceId/knowledge-bases/:baseId": {
		summary: "Rename or re-describe a knowledge base",
		tags: ["Knowledge"],
		access: "owner, admin, member",
		body: updateKnowledgeBaseSchema,
	},
	"DELETE /v1/workspaces/:workspaceId/knowledge-bases/:baseId": {
		summary: "Delete it and everything derived from it — vectors, objects and rows",
		tags: ["Knowledge"],
		access: "owner, admin",
		status: 204,
	},
	"GET /v1/workspaces/:workspaceId/knowledge-bases/:baseId/documents": {
		summary: "List documents with their ingestion status",
		tags: ["Knowledge"],
		access: "any member",
		query: paginationQuerySchema,
	},
	"POST /v1/workspaces/:workspaceId/knowledge-bases/:baseId/documents": {
		summary:
			"Upload a document as multipart/form-data under `file`. Returns the pending row; indexing runs in the worker",
		tags: ["Knowledge"],
		access: "owner, admin, member",
		status: 201,
	},
	"GET /v1/workspaces/:workspaceId/documents/:documentId": {
		summary: "Document detail and why it failed, if it did",
		tags: ["Knowledge"],
		access: "any member",
	},
	"GET /v1/workspaces/:workspaceId/documents/:documentId/download": {
		summary: "A short-lived presigned URL for the original file",
		tags: ["Knowledge"],
		access: "any member",
	},
	"GET /v1/workspaces/:workspaceId/documents/:documentId/chunks": {
		summary: "The passages a document was split into",
		tags: ["Knowledge"],
		access: "any member",
		query: paginationQuerySchema,
	},
	"POST /v1/workspaces/:workspaceId/documents/:documentId/reindex": {
		summary: "Queue the document again. Re-embedding costs credits",
		tags: ["Knowledge"],
		access: "owner, admin, member",
	},
	"DELETE /v1/workspaces/:workspaceId/documents/:documentId": {
		summary: "Delete a document, its chunks, its vectors and its stored file",
		tags: ["Knowledge"],
		access: "owner, admin, member",
		status: 204,
	},

	"GET /v1/workspaces/:workspaceId/conversations": {
		summary: "List conversations, most recent first",
		tags: ["Chat"],
		access: "any member",
		query: paginationQuerySchema,
	},
	"POST /v1/workspaces/:workspaceId/conversations": {
		summary: "Start a conversation. A null knowledgeBaseId answers without retrieval",
		tags: ["Chat"],
		access: "owner, admin, member",
		body: createConversationSchema,
		status: 201,
	},
	"GET /v1/workspaces/:workspaceId/conversations/:conversationId": {
		summary: "Conversation detail",
		tags: ["Chat"],
		access: "any member",
	},
	"PATCH /v1/workspaces/:workspaceId/conversations/:conversationId": {
		summary: "Rename a conversation or point it at another knowledge base",
		tags: ["Chat"],
		access: "owner, admin, member",
		body: updateConversationSchema,
	},
	"DELETE /v1/workspaces/:workspaceId/conversations/:conversationId": {
		summary: "Delete a conversation and its messages",
		tags: ["Chat"],
		access: "owner, admin, member",
		status: 204,
	},
	"GET /v1/workspaces/:workspaceId/conversations/:conversationId/messages": {
		summary: "The transcript, oldest first, with the citations each answer used",
		tags: ["Chat"],
		access: "any member",
		query: paginationQuerySchema,
	},
	"POST /v1/workspaces/:workspaceId/conversations/:conversationId/messages": {
		summary: "Ask a question and wait for the whole answer",
		tags: ["Chat"],
		access: "owner, admin, member",
		body: sendMessageSchema,
		status: 201,
	},
	"POST /v1/workspaces/:workspaceId/conversations/:conversationId/messages/stream": {
		summary:
			"The same turn over SSE. Events: citations, delta, done, error. Refusals arrive as a status code before the stream opens",
		tags: ["Chat"],
		access: "owner, admin, member",
		body: sendMessageSchema,
	},

	"GET /v1/admin/providers": {
		summary: "Providers, credential state (masked) and the merged model catalogue",
		tags: ["Admin"],
		access: "platform admin",
	},
	"PUT /v1/admin/providers/:provider/credential": {
		summary: "Store a provider API key. Encrypted at rest and never returned",
		tags: ["Admin"],
		access: "platform admin",
		body: saveCredentialSchema,
	},
	"DELETE /v1/admin/providers/:provider/credential": {
		summary: "Remove a provider API key",
		tags: ["Admin"],
		access: "platform admin",
	},
	"POST /v1/admin/providers/:provider/check": {
		summary: "Call the provider with the stored key. Answers 200 with ok=false on rejection",
		tags: ["Admin"],
		access: "platform admin",
	},
	"POST /v1/admin/models": {
		summary: "Add a model or replace its definition",
		tags: ["Admin"],
		access: "platform admin",
		body: upsertModelSchema,
		status: 201,
	},
	"PATCH /v1/admin/providers/:provider/models/:model": {
		summary: "Change one field of a model, built-in models included",
		tags: ["Admin"],
		access: "platform admin",
		body: patchModelSchema,
	},
	"DELETE /v1/admin/providers/:provider/models/:model": {
		summary: "Drop the stored row. A built-in model reverts to its compiled definition",
		tags: ["Admin"],
		access: "platform admin",
	},
	"GET /v1/admin/settings/models": {
		summary: "Platform default chat and embedding models",
		tags: ["Admin"],
		access: "platform admin",
	},
	"PUT /v1/admin/settings/models": {
		summary: "Change the platform defaults",
		tags: ["Admin"],
		access: "platform admin",
		body: setPlatformDefaultsSchema,
	},

	"GET /v1/workspaces/:workspaceId/billing/promo-codes": {
		summary: "Promo codes this workspace has redeemed",
		tags: ["Billing"],
		access: "any member",
	},
	"POST /v1/workspaces/:workspaceId/billing/promo-codes/redeem": {
		summary: "Redeem a promo code for this workspace",
		tags: ["Billing"],
		access: "owner, admin",
		body: redeemPromoCodeSchema,
	},
}

type JsonSchema = Record<string, unknown>

/**
 * Zod 4 emits JSON Schema natively, so the request shapes in the docs are the
 * exact schemas the handlers validate with — they cannot drift.
 */
function toJsonSchema(schema: z.ZodType): JsonSchema {
	try {
		return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema
	} catch {
		return { type: "object" }
	}
}

function queryParameters(schema: z.ZodType) {
	const json = toJsonSchema(schema)
	const properties = (json.properties ?? {}) as Record<string, JsonSchema>
	const required = (json.required ?? []) as string[]

	return Object.entries(properties).map(([name, propertySchema]) => ({
		name,
		in: "query" as const,
		required: required.includes(name),
		schema: propertySchema,
	}))
}

function pathParameters(path: string) {
	return [...path.matchAll(/:(\w+)/g)].map((match) => ({
		name: match[1] as string,
		in: "path" as const,
		required: true,
		schema: { type: "string" },
	}))
}

function toOpenApiPath(path: string) {
	return path.replace(/:(\w+)/g, "{$1}")
}

const ERROR_RESPONSE = {
	description: "Error",
	content: {
		"application/json": {
			schema: {
				type: "object",
				properties: {
					error: {
						type: "object",
						properties: {
							code: { type: "string" },
							message: { type: "string" },
							details: {},
						},
						required: ["code", "message"],
					},
					requestId: { type: "string" },
				},
				required: ["error", "requestId"],
			},
		},
	},
}

function successStatus(method: string, meta?: RouteMeta) {
	if (meta?.status) return String(meta.status)
	return method === "POST" ? "201" : "200"
}

/**
 * Better Auth documents itself through its `openAPI` plugin. Pulling that schema
 * in and prefixing it with the auth base path makes `/v1/docs` the single place
 * to read the whole API instead of two half-documents.
 *
 * Cast because the method only exists when the plugin is enabled, and the
 * plugin-composed `auth.api` type does not expose it statically.
 */
async function betterAuthPaths(): Promise<Record<string, unknown>> {
	const api = auth.api as unknown as {
		generateOpenAPISchema?: () => Promise<{ paths?: Record<string, unknown> }>
	}
	if (typeof api.generateOpenAPISchema !== "function") return {}

	try {
		const schema = await api.generateOpenAPISchema()
		const prefixed: Record<string, unknown> = {}
		for (const [path, item] of Object.entries(schema.paths ?? {})) {
			prefixed[`/v1/auth${path}`] = item
		}
		return prefixed
	} catch (error) {
		logger.warn("Could not read the Better Auth OpenAPI schema", {
			reason: error instanceof Error ? error.message : String(error),
		})
		return {}
	}
}

export async function buildOpenApiDocument(app: Hono<AppEnv>) {
	const paths: Record<string, Record<string, unknown>> = {}
	const seen = new Set<string>()

	for (const route of app.routes) {
		// `ALL` entries are middleware registrations, and Better Auth's catch-all
		// is documented from its own schema below.
		if (route.method === "ALL") continue
		if (route.path.startsWith("/v1/auth")) continue
		if (route.path !== "/health" && !route.path.startsWith("/v1/")) continue

		const key = `${route.method} ${route.path}`
		// A route with middleware registers once per handler; document it once.
		if (seen.has(key)) continue
		seen.add(key)

		const meta = ROUTE_DOCS[key]
		const openApiPath = toOpenApiPath(route.path)
		paths[openApiPath] ??= {}

		const parameters = [
			...pathParameters(route.path),
			...(meta?.query ? queryParameters(meta.query) : []),
		]

		paths[openApiPath][route.method.toLowerCase()] = {
			summary: meta?.summary ?? `${route.method} ${route.path}`,
			tags: meta?.tags ?? ["Undocumented"],
			...(meta?.access ? { description: `Requires: ${meta.access}.` } : {}),
			...(parameters.length > 0 ? { parameters } : {}),
			...(meta?.body
				? {
						requestBody: {
							required: true,
							content: { "application/json": { schema: toJsonSchema(meta.body) } },
						},
					}
				: {}),
			responses: {
				[successStatus(route.method, meta)]: { description: "Success" },
				"401": ERROR_RESPONSE,
				"403": ERROR_RESPONSE,
				"404": ERROR_RESPONSE,
				"422": ERROR_RESPONSE,
			},
		}
	}

	return {
		openapi: "3.1.0",
		info: {
			title: "Ragenta API",
			version: "0.1.0",
			description:
				"Workspaces, projects, billing and usage.\n\n" +
				"Identity lives under `/v1/auth/*` and is served by Better Auth: sign-in, " +
				"sign-up, password reset, and the organization primitives (accept invitation, " +
				"set active workspace, leave workspace).\n\n" +
				"Authenticate with the session cookie the sign-in call sets, or with a bearer token.",
		},
		servers: [{ url: env.apiBaseUrl }],
		components: {
			securitySchemes: {
				sessionCookie: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
				bearerAuth: { type: "http", scheme: "bearer" },
			},
		},
		security: [{ sessionCookie: [] }, { bearerAuth: [] }],
		paths: { ...paths, ...(await betterAuthPaths()) },
	}
}

/** Scalar's standalone reference, loaded from a CDN. No build step, no dependency. */
export const docsPage = `<!doctype html>
<html>
  <head>
    <title>Ragenta API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="/v1/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`
