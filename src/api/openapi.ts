import type { Hono } from "hono"
import { z } from "zod"

import { auth } from "../auth/auth"
import { env } from "../config/env"
import { adjustCreditsSchema, adminListQuerySchema, setPlanSchema } from "../modules/admin/admin.dto"
import { createApiKeySchema } from "../modules/apikey/apikey.dto"
import {
	agentConfigSchema,
	createAgentSchema,
	createFromTemplateSchema,
	resumeRunSchema,
	runAgentSchema,
	updateAgentSchema,
} from "../modules/agent/agent.dto"
import { createCheckoutSchema, updateAutoReloadSchema } from "../modules/billing/billing.dto"
import { saveIntegrationSchema } from "../modules/integration/integration.dto"
import {
	createConversationSchema,
	sendMessageSchema,
	updateConversationSchema,
} from "../modules/chat/chat.dto"
import {
	createKnowledgeBaseSchema,
	reindexDocumentSchema,
	updateKnowledgeBaseSchema,
} from "../modules/knowledge/knowledge.dto"
import {
	dryRunSchema,
	generateQuerySchema,
	saveDataSourceSchema,
	saveQuerySchema,
} from "../modules/datasource/datasource.dto"
import { saveMcpServerSchema } from "../modules/mcp/mcp.dto"
import { saveWebhookEndpointSchema } from "../modules/webhook/webhook.dto"
import { saveOAuthClientSchema, startOAuthSchema } from "../modules/oauth/oauth.dto"
import { updateModelSettingsSchema } from "../modules/model/model.dto"
import {
	patchModelSchema,
	saveCredentialSchema,
	setPlatformDefaultsSchema,
	upsertModelSchema,
} from "../modules/provider/provider.dto"
import { saveSpeechEndpointSchema } from "../modules/speech/speech.admin.dto"
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
	createRoleSchema,
	createWorkspaceRoleSchema,
	listRolesQuerySchema,
	setRolesSchema,
	updateRoleSchema,
} from "../modules/rbac/rbac.dto"
import { saveTriggerSchema } from "../modules/trigger/trigger.dto"
import {
	synthesizeSpeechSchema,
	transcribeAttachmentSchema,
} from "../modules/speech/speech.dto"
import { platformUsageQuerySchema } from "../modules/usage/platform-usage.dto"
import { saveWidgetSchema, widgetMessageSchema } from "../modules/widget/widget.dto"
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
		access: "workspace.update",
		body: updateWorkspaceSchema,
	},
	"GET /v1/workspaces/:workspaceId/permissions": {
		summary: "What the caller may do in this workspace",
		tags: ["Workspaces"],
		access: "any member",
	},
	"GET /v1/workspaces/:workspaceId/roles": {
		summary: "Roles this workspace can assign",
		tags: ["Workspaces"],
		access: "any member",
	},
	"POST /v1/workspaces/:workspaceId/roles": {
		summary: "Create a role this workspace owns",
		tags: ["Workspaces"],
		access: "role.manage",
		body: createWorkspaceRoleSchema,
		status: 201,
	},
	"PATCH /v1/workspaces/:workspaceId/roles/:roleId": {
		summary: "Change a role this workspace owns",
		tags: ["Workspaces"],
		access: "role.manage",
		body: updateRoleSchema,
	},
	"DELETE /v1/workspaces/:workspaceId/roles/:roleId": {
		summary: "Delete a role this workspace owns and nobody holds",
		tags: ["Workspaces"],
		access: "role.manage",
		status: 204,
	},
	"GET /v1/workspaces/:workspaceId/members/:memberId/roles": {
		summary: "The roles a member holds",
		tags: ["Workspaces"],
		access: "any member",
	},
	"PUT /v1/workspaces/:workspaceId/members/:memberId/roles": {
		summary: "Set the roles a member holds",
		tags: ["Workspaces"],
		access: "member.update",
		body: setRolesSchema,
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
		access: "member.update",
		body: updateMemberRoleSchema,
	},
	"DELETE /v1/workspaces/:workspaceId/members/:memberId": {
		summary: "Remove a member",
		tags: ["Workspaces"],
		access: "member.remove",
		status: 204,
	},
	"GET /v1/workspaces/:workspaceId/invitations": {
		summary: "List pending invitations",
		tags: ["Workspaces"],
		access: "invitation.read",
	},
	"POST /v1/workspaces/:workspaceId/invitations": {
		summary: "Invite someone. Refused with SEAT_LIMIT_REACHED when the plan is full",
		tags: ["Workspaces"],
		access: "invitation.create",
		body: inviteMemberSchema,
		status: 201,
	},
	"DELETE /v1/workspaces/:workspaceId/invitations/:invitationId": {
		summary: "Cancel an invitation",
		tags: ["Workspaces"],
		access: "invitation.revoke",
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
		access: "project.create",
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
		access: "project.update",
		body: updateProjectSchema,
	},
	"POST /v1/workspaces/:workspaceId/projects/:projectId/archive": {
		summary: "Archive a project (reversible, keeps usage history)",
		tags: ["Projects"],
		access: "project.archive",
	},
	"POST /v1/workspaces/:workspaceId/projects/:projectId/restore": {
		summary: "Restore an archived project",
		tags: ["Projects"],
		access: "project.archive",
	},
	"DELETE /v1/workspaces/:workspaceId/projects/:projectId": {
		summary: "Delete a project permanently. Must be archived first",
		tags: ["Projects"],
		access: "project.delete",
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
		access: "transaction.read",
		query: paginationQuerySchema,
	},

	"POST /v1/workspaces/:workspaceId/billing/checkout": {
		summary: "Start Stripe checkout for a plan or a top-up pack",
		tags: ["Billing"],
		access: "billing.manage",
		body: createCheckoutSchema,
		status: 200,
	},
	"POST /v1/workspaces/:workspaceId/billing/portal": {
		summary: "Open the Stripe billing portal (cards, invoices, cancellation)",
		tags: ["Billing"],
		access: "billing.manage",
		status: 200,
	},
	"GET /v1/workspaces/:workspaceId/billing/auto-reload": {
		summary: "Auto-reload settings and the last failure, if any",
		tags: ["Billing"],
		access: "billing.manage",
	},
	"PUT /v1/workspaces/:workspaceId/billing/auto-reload": {
		summary: "Enable or change auto-reload. Requires a card already on file",
		tags: ["Billing"],
		access: "billing.manage",
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
		access: "model.manage",
		body: updateModelSettingsSchema,
	},

	"GET /v1/admin/users": {
		summary: "List all users",
		tags: ["Admin"],
		access: "admin.user.read",
		query: adminListQuerySchema,
	},
	"GET /v1/admin/workspaces": {
		summary: "List all workspaces with plan and balance",
		tags: ["Admin"],
		access: "admin.workspace.read",
		query: adminListQuerySchema,
	},
	"GET /v1/admin/workspaces/:workspaceId": {
		summary: "Workspace detail",
		tags: ["Admin"],
		access: "admin.workspace.read",
	},
	"POST /v1/admin/workspaces/:workspaceId/credits": {
		summary: "Signed credit adjustment. Writes the ledger and the audit trail",
		tags: ["Admin"],
		access: "admin.credit.adjust",
		body: adjustCreditsSchema,
	},
	"PUT /v1/admin/workspaces/:workspaceId/plan": {
		summary: "Change a workspace's plan",
		tags: ["Admin"],
		access: "admin.workspace.manage",
		body: setPlanSchema,
	},
	"GET /v1/admin/audit-log": {
		summary: "Audit trail",
		tags: ["Admin"],
		access: "admin.audit.read",
		query: paginationQuerySchema,
	},

	"GET /v1/admin/promo-codes": {
		summary: "List promo codes, newest first",
		tags: ["Admin"],
		access: "admin.promo.read",
		query: listPromoCodesQuerySchema,
	},
	"POST /v1/admin/promo-codes": {
		summary: "Create a promo code",
		tags: ["Admin"],
		access: "admin.promo.manage",
		body: createPromoCodeSchema,
		status: 201,
	},
	"PATCH /v1/admin/promo-codes/:promoCodeId": {
		summary: "Enable or disable a promo code — the only mutable field",
		tags: ["Admin"],
		access: "admin.promo.manage",
		body: updatePromoCodeSchema,
	},
	"DELETE /v1/admin/promo-codes/:promoCodeId": {
		summary: "Delete a code nobody redeemed. Refused with 409 once one has",
		tags: ["Admin"],
		access: "admin.promo.manage",
		status: 204,
	},
	"GET /v1/admin/promo-codes/:promoCodeId/redemptions": {
		summary: "Which workspaces redeemed a code",
		tags: ["Admin"],
		access: "admin.promo.read",
		query: paginationQuerySchema,
	},

	"GET /v1/workspaces/:workspaceId/knowledge-bases/chunking-methods": {
		summary:
			"The chunking strategies this deployment offers, the formats each reads, and why an unavailable one is unavailable",
		tags: ["Knowledge"],
		access: "any member",
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
		access: "knowledgeBase.create",
		body: createKnowledgeBaseSchema,
		status: 201,
	},
	"GET /v1/workspaces/:workspaceId/knowledge-bases/:baseId": {
		summary: "Knowledge base detail with document and chunk counts",
		tags: ["Knowledge"],
		access: "any member",
	},
	"PATCH /v1/workspaces/:workspaceId/knowledge-bases/:baseId": {
		summary:
			"Edit a knowledge base. Retrieval settings apply at once; chunking settings apply to documents re-indexed after the change",
		tags: ["Knowledge"],
		access: "knowledgeBase.update",
		body: updateKnowledgeBaseSchema,
	},
	"DELETE /v1/workspaces/:workspaceId/knowledge-bases/:baseId": {
		summary: "Delete it and everything derived from it — vectors, objects and rows",
		tags: ["Knowledge"],
		access: "knowledgeBase.delete",
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
			"Upload a document as multipart/form-data under `file`, optionally with `parserId` and a JSON `parserConfig` overriding the base's. Returns the pending row; indexing runs in the worker",
		tags: ["Knowledge"],
		access: "document.create",
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
	"GET /v1/workspaces/:workspaceId/documents/:documentId/tasks": {
		summary:
			"The ingestion plan: one row per page range, with its digest, status and whether it was reused from the last run",
		tags: ["Knowledge"],
		access: "any member",
	},
	"POST /v1/workspaces/:workspaceId/documents/:documentId/reindex": {
		summary:
			"Queue the document again, optionally changing its chunking method. Ranges whose settings did not change are reused rather than re-embedded, so only what changed costs credits",
		tags: ["Knowledge"],
		access: "document.update",
		body: reindexDocumentSchema,
	},
	"POST /v1/workspaces/:workspaceId/documents/:documentId/cancel": {
		summary:
			"Ask the worker to stop between stages. Passages already indexed are kept — they were paid for",
		tags: ["Knowledge"],
		access: "document.update",
	},
	"DELETE /v1/workspaces/:workspaceId/documents/:documentId": {
		summary: "Delete a document, its chunks, its vectors and its stored file",
		tags: ["Knowledge"],
		access: "document.delete",
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
		access: "conversation.create",
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
		access: "conversation.update",
		body: updateConversationSchema,
	},
	"DELETE /v1/workspaces/:workspaceId/conversations/:conversationId": {
		summary: "Delete a conversation and its messages",
		tags: ["Chat"],
		access: "conversation.delete",
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
		access: "chat.send",
		body: sendMessageSchema,
		status: 201,
	},
	"POST /v1/workspaces/:workspaceId/conversations/:conversationId/messages/stream": {
		summary:
			"The same turn over SSE. Events: citations, delta, done, error. Refusals arrive as a status code before the stream opens",
		tags: ["Chat"],
		access: "chat.send",
		body: sendMessageSchema,
	},
	"POST /v1/workspaces/:workspaceId/conversations/:conversationId/messages/:messageId/stop": {
		summary:
			"Stop a turn that is generating. The partial answer is saved and the stream ends with its normal `done` frame, so the text already on screen survives",
		tags: ["Chat"],
		access: "chat.send",
	},

	"POST /v1/workspaces/:workspaceId/attachments": {
		summary:
			"Upload an image or a recording as multipart/form-data under `file`. The kind and the stored type are sniffed from the bytes, not taken from the declared ones, and the row comes back unbound until a message is sent with it",
		tags: ["Attachments"],
		access: "attachment.create",
		status: 201,
	},
	"GET /v1/workspaces/:workspaceId/attachments/:attachmentId": {
		summary: "Attachment metadata, and the extraction once one exists",
		tags: ["Attachments"],
		access: "any member",
	},
	"GET /v1/workspaces/:workspaceId/attachments/:attachmentId/content": {
		summary: "Redirects to a short-lived presigned URL for the bytes. Usable as an image source",
		tags: ["Attachments"],
		access: "any member",
		status: 302,
	},
	"DELETE /v1/workspaces/:workspaceId/attachments/:attachmentId": {
		summary:
			"Discard an attachment that has not been sent yet. Refused with a conflict once it belongs to a message — delete the message instead",
		tags: ["Attachments"],
		access: "attachment.delete",
		status: 204,
	},

	"POST /v1/workspaces/:workspaceId/attachments/:attachmentId/transcribe": {
		summary:
			"Transcribe a stored recording. The transcript is written onto the attachment, so a repeat call returns it with `cached: true` and charges nothing. Runs inside the request, and is charged on the duration the provider reports",
		tags: ["Speech"],
		access: "speech.transcribe",
		body: transcribeAttachmentSchema,
	},
	"POST /v1/workspaces/:workspaceId/speech": {
		summary:
			"Speak a piece of text and return the audio bytes under the format's own content type. Charged per input character",
		tags: ["Speech"],
		access: "speech.synthesize",
		body: synthesizeSpeechSchema,
	},

	"GET /v1/workspaces/:workspaceId/agent-tools": {
		summary: "The tools this deployment can give an agent",
		tags: ["Agents"],
		access: "any member",
	},
	"GET /v1/workspaces/:workspaceId/agents": {
		summary: "List agents, most recently changed first",
		tags: ["Agents"],
		access: "any member",
		query: paginationQuerySchema,
	},
	"POST /v1/workspaces/:workspaceId/agents": {
		summary: "Create an agent. Version 1 is written with it and the agent starts as a draft",
		tags: ["Agents"],
		access: "agent.create",
		body: createAgentSchema,
		status: 201,
	},
	"GET /v1/workspaces/:workspaceId/agents/:agentId": {
		summary: "Agent detail, with the configuration of its current version",
		tags: ["Agents"],
		access: "any member",
	},
	"PATCH /v1/workspaces/:workspaceId/agents/:agentId": {
		summary:
			"Rename an agent, move it between projects, or change its status. The configuration is republished, never patched",
		tags: ["Agents"],
		access: "agent.update",
		body: updateAgentSchema,
	},
	"DELETE /v1/workspaces/:workspaceId/agents/:agentId": {
		summary: "Delete an agent, its versions and its run history",
		tags: ["Agents"],
		access: "agent.delete",
		status: 204,
	},
	"GET /v1/workspaces/:workspaceId/agents/:agentId/versions": {
		summary: "Every version of this agent, newest first",
		tags: ["Agents"],
		access: "any member",
	},
	"POST /v1/workspaces/:workspaceId/agents/:agentId/versions": {
		summary:
			"Publish a new immutable version and make it current. Runs already in flight keep the version they started on",
		tags: ["Agents"],
		access: "agent.publish",
		body: agentConfigSchema,
		status: 201,
	},
	"GET /v1/workspaces/:workspaceId/agents/:agentId/runs": {
		summary: "Run history for one agent, newest first",
		tags: ["Agents"],
		access: "any member",
		query: paginationQuerySchema,
	},
	"POST /v1/workspaces/:workspaceId/agents/:agentId/runs": {
		summary:
			"Run the agent over SSE. Events: phase, citations, warning, delta, done, error. Refusals arrive as a status code before the stream opens",
		tags: ["Agents"],
		access: "agent.run",
		body: runAgentSchema,
	},
	"POST /v1/workspaces/:workspaceId/agents/:agentId/runs/queue": {
		summary:
			"Queue the run for the worker instead of streaming it. Returns a run id straight away; the steps and the answer are read back from the run, which the worker writes as it goes",
		tags: ["Agents"],
		access: "agent.run",
		body: runAgentSchema,
		status: 202,
	},
	"GET /v1/workspaces/:workspaceId/agent-runs/:runId": {
		summary:
			"One run, with its status, output, total credits and how many times it has been started",
		tags: ["Agents"],
		access: "any member",
	},
	"GET /v1/workspaces/:workspaceId/agent-runs/:runId/steps": {
		summary: "The steps of a run, in order, each with what it cost",
		tags: ["Agents"],
		access: "any member",
	},
	"POST /v1/workspaces/:workspaceId/agent-runs/:runId/resume": {
		summary:
			"Answer what a paused flow asked for and carry on, over SSE on the same run",
		tags: ["Agents"],
		access: "agentRun.control",
		body: resumeRunSchema,
	},
	"POST /v1/workspaces/:workspaceId/agent-runs/:runId/stop": {
		summary:
			"Stop or cancel a run. It ends at its next node boundary, keeps what it has and can be retried from there; a run still queued is cancelled outright",
		tags: ["Agents"],
		access: "agentRun.control",
	},
	"POST /v1/workspaces/:workspaceId/agent-runs/:runId/retry": {
		summary:
			"Run a failed or stopped run again on the queue, from its last checkpoint. Work the first attempt was already billed for is not charged again",
		tags: ["Agents"],
		access: "agentRun.control",
		status: 202,
	},

	"GET /v1/workspaces/:workspaceId/connections": {
		summary:
			"Connections the workspace's agents may name: its own plus the platform-wide ones, each labelled with its scope. Allowlists included, secrets masked",
		tags: ["Connections"],
		access: "any member",
	},
	"GET /v1/workspaces/:workspaceId/connections/:connectionId": {
		summary:
			"One connection by the name an agent uses, resolved as a run resolves it — the workspace's own shadows a platform-wide one of the same name",
		tags: ["Connections"],
		access: "any member",
	},
	"PUT /v1/workspaces/:workspaceId/connections/:connectionId": {
		summary:
			"Create or replace one of the workspace's connections. The secret is encrypted at rest and never returned; omitting it keeps the stored one",
		tags: ["Connections"],
		access: "connection.manage",
		body: saveIntegrationSchema,
	},
	"DELETE /v1/workspaces/:workspaceId/connections/:connectionId": {
		summary: "Delete one of the workspace's connections. Agents naming it then refuse",
		tags: ["Connections"],
		access: "connection.manage",
		status: 204,
	},
	"POST /v1/workspaces/:workspaceId/connections/:connectionId/check": {
		summary:
			"One live call proving the workspace's own connection works. The outcome is kept on the row; a platform-wide connection is the administrator's to test",
		tags: ["Connections"],
		access: "connection.manage",
	},

	"GET /v1/admin/integrations": {
		summary:
			"Platform-wide connections every workspace may use, with their allowlists (secrets masked). A workspace's own live under /v1/workspaces/:workspaceId/connections",
		tags: ["Admin"],
		access: "admin.integration.read",
	},
	"GET /v1/admin/integrations/:integrationId": {
		summary: "One integration",
		tags: ["Admin"],
		access: "admin.integration.read",
	},
	"PUT /v1/admin/integrations/:integrationId": {
		summary:
			"Create or replace an integration. Omitting `secret` keeps the stored key, so editing an allowlist is not a key rotation",
		tags: ["Admin"],
		access: "admin.integration.manage",
		body: saveIntegrationSchema,
	},
	"DELETE /v1/admin/integrations/:integrationId": {
		summary: "Delete an integration. Agents naming it then refuse",
		tags: ["Admin"],
		access: "admin.integration.manage",
		status: 204,
	},
	"POST /v1/admin/integrations/:integrationId/check": {
		summary: "One live call proving the connection works. The outcome is kept on the row",
		tags: ["Admin"],
		access: "admin.integration.manage",
	},
	"GET /v1/admin/providers": {
		summary: "Providers, credential state (masked) and the merged model catalogue",
		tags: ["Admin"],
		access: "admin.provider.read",
	},
	"PUT /v1/admin/providers/:provider/credential": {
		summary: "Store a provider API key. Encrypted at rest and never returned",
		tags: ["Admin"],
		access: "admin.provider.manage",
		body: saveCredentialSchema,
	},
	"DELETE /v1/admin/providers/:provider/credential": {
		summary: "Remove a provider API key",
		tags: ["Admin"],
		access: "admin.provider.manage",
	},
	"POST /v1/admin/providers/:provider/check": {
		summary: "Call the provider with the stored key. Answers 200 with ok=false on rejection",
		tags: ["Admin"],
		access: "admin.provider.manage",
	},
	"GET /v1/admin/speech": {
		summary:
			"Transcription and synthesis configuration, and which source each half resolves from. The key is never returned — only its masked hint",
		tags: ["Admin"],
		access: "admin.speech.read",
	},
	"PUT /v1/admin/speech/:capability": {
		summary:
			"Configure one half — `stt` or `tts` — against any OpenAI-audio-compatible host. Omitting apiKey keeps the stored one",
		tags: ["Admin"],
		access: "admin.speech.manage",
		body: saveSpeechEndpointSchema,
	},
	"DELETE /v1/admin/speech/:capability": {
		summary: "Clear one half, falling back to whatever the environment configures",
		tags: ["Admin"],
		access: "admin.speech.manage",
	},
	"POST /v1/admin/speech/:capability/check": {
		summary:
			"Transcribe a second of generated silence, or synthesise a short phrase. Answers 200 with ok=false on rejection",
		tags: ["Admin"],
		access: "admin.speech.manage",
	},
	"POST /v1/admin/providers/:provider/models/import": {
		summary:
			"Import the provider's own catalogue, priced from its own API. Offered only where a provider publishes prices machine-readably — OpenRouter today. Upserts, never deletes, so re-running it refreshes prices",
		tags: ["Admin"],
		access: "admin.model.manage",
	},
	"POST /v1/admin/models": {
		summary: "Add a model or replace its definition",
		tags: ["Admin"],
		access: "admin.model.manage",
		body: upsertModelSchema,
		status: 201,
	},
	"PATCH /v1/admin/providers/:provider/models/:model": {
		summary: "Change one field of a model, built-in models included",
		tags: ["Admin"],
		access: "admin.model.manage",
		body: patchModelSchema,
	},
	"DELETE /v1/admin/providers/:provider/models/:model": {
		summary: "Drop the stored row. A built-in model reverts to its compiled definition",
		tags: ["Admin"],
		access: "admin.model.manage",
	},
	"GET /v1/admin/settings/models": {
		summary: "Platform default chat and embedding models",
		tags: ["Admin"],
		access: "admin.model.read",
	},
	"PUT /v1/admin/settings/models": {
		summary: "Change the platform defaults",
		tags: ["Admin"],
		access: "admin.model.manage",
		body: setPlatformDefaultsSchema,
	},
	"GET /v1/admin/settings/model-access": {
		summary: "Which models each plan may offer",
		tags: ["Admin"],
		access: "admin.model.read",
	},
	"PUT /v1/admin/settings/model-access/:plan": {
		summary: "Set which models one plan may offer",
		tags: ["Admin"],
		access: "admin.model.manage",
	},
	"GET /v1/admin/permissions": {
		summary: "The permission catalogue this release checks",
		tags: ["Admin"],
		access: "admin.role.read",
	},
	"GET /v1/admin/roles": {
		summary: "List roles and what each one may do",
		tags: ["Admin"],
		access: "admin.role.read",
		query: listRolesQuerySchema,
	},
	"POST /v1/admin/roles": {
		summary: "Create a role",
		tags: ["Admin"],
		access: "admin.role.manage",
		body: createRoleSchema,
		status: 201,
	},
	"GET /v1/admin/roles/:roleId": {
		summary: "Read one role",
		tags: ["Admin"],
		access: "admin.role.read",
	},
	"PATCH /v1/admin/roles/:roleId": {
		summary: "Rename a role or change what it may do",
		tags: ["Admin"],
		access: "admin.role.manage",
		body: updateRoleSchema,
	},
	"DELETE /v1/admin/roles/:roleId": {
		summary: "Delete a role nobody holds",
		tags: ["Admin"],
		access: "admin.role.manage",
		status: 204,
	},
	"GET /v1/admin/users/:userId/platform-roles": {
		summary: "The console roles somebody holds",
		tags: ["Admin"],
		access: "admin.role.read",
	},
	"PUT /v1/admin/users/:userId/platform-roles": {
		summary: "Set the console roles somebody holds",
		tags: ["Admin"],
		access: "admin.role.manage",
		body: setRolesSchema,
	},
	"GET /v1/admin/workspaces/:workspaceId/members/:memberId/roles": {
		summary: "The roles a workspace member holds",
		tags: ["Admin"],
		access: "admin.role.read",
	},
	"PUT /v1/admin/workspaces/:workspaceId/members/:memberId/roles": {
		summary: "Set the roles a workspace member holds",
		tags: ["Admin"],
		access: "admin.role.manage",
		body: setRolesSchema,
	},
	"GET /v1/admin/usage": {
		summary: "Platform spend: totals, by model, by operation, by workspace, by day",
		tags: ["Admin"],
		access: "admin.usage.read",
		query: platformUsageQuerySchema,
	},
	"GET /v1/admin/usage/models": {
		summary: "Platform spend grouped by model",
		tags: ["Admin"],
		access: "admin.usage.read",
		query: platformUsageQuerySchema,
	},
	"GET /v1/admin/usage/workspaces": {
		summary: "Platform spend grouped by workspace",
		tags: ["Admin"],
		access: "admin.usage.read",
		query: platformUsageQuerySchema,
	},
	"GET /v1/admin/provider-errors": {
		summary: "Provider calls that failed, and how often each kind is failing",
		tags: ["Admin"],
		access: "admin.errors.read",
		query: platformUsageQuerySchema,
	},
	"GET /v1/workspaces/:workspaceId/webhooks": {
		summary: "Where this workspace is told about things, and the event catalogue",
		tags: ["Workspaces"],
		access: "webhook.read",
	},
	"POST /v1/workspaces/:workspaceId/webhooks": {
		summary: "Add an endpoint. Its signing secret is shown once",
		tags: ["Workspaces"],
		access: "webhook.manage",
		body: saveWebhookEndpointSchema,
		status: 201,
	},
	"PUT /v1/workspaces/:workspaceId/webhooks/:endpointId": {
		summary: "Change an endpoint's name, URL or subscriptions",
		tags: ["Workspaces"],
		access: "webhook.manage",
		body: saveWebhookEndpointSchema,
	},
	"POST /v1/workspaces/:workspaceId/webhooks/:endpointId/rotate-secret": {
		summary: "Issue a new signing secret, shown once. The old one stops working",
		tags: ["Workspaces"],
		access: "webhook.manage",
	},
	"DELETE /v1/workspaces/:workspaceId/webhooks/:endpointId": {
		summary: "Remove an endpoint",
		tags: ["Workspaces"],
		access: "webhook.manage",
		status: 204,
	},
	"GET /v1/workspaces/:workspaceId/webhook-deliveries": {
		summary: "Every attempt to deliver an event, whether it worked or not",
		tags: ["Workspaces"],
		access: "webhook.read",
	},
	"GET /v1/workspaces/:workspaceId/provider-errors": {
		summary: "This workspace's own failed provider calls",
		tags: ["Workspaces"],
		access: "usage.read",
	},
	"GET /v1/admin/mcp-servers": {
		summary: "MCP servers configured for the whole deployment",
		tags: ["Admin"],
		access: "admin.mcp.read",
	},
	"PUT /v1/admin/mcp-servers": {
		summary: "Add or change a deployment-wide MCP server",
		tags: ["Admin"],
		access: "admin.mcp.manage",
		body: saveMcpServerSchema,
	},
	"DELETE /v1/admin/mcp-servers/:serverId": {
		summary: "Remove a deployment-wide MCP server",
		tags: ["Admin"],
		access: "admin.mcp.manage",
		status: 204,
	},
	"POST /v1/admin/mcp-servers/:serverId/check": {
		summary: "Ask an MCP server what tools it offers, and record the outcome",
		tags: ["Admin"],
		access: "admin.mcp.manage",
	},
	"GET /v1/workspaces/:workspaceId/mcp-servers": {
		summary: "MCP servers this workspace's agents may reach",
		tags: ["Agents"],
		access: "mcpServer.read",
	},
	"GET /v1/workspaces/:workspaceId/mcp-tools": {
		summary: "The MCP tools an agent version may name",
		tags: ["Agents"],
		access: "mcpServer.read",
	},
	"GET /v1/workspaces/:workspaceId/agent-templates": {
		summary: "Agents you can start from, with each one's tools marked available or not",
		tags: ["Agents"],
		access: "any member",
	},
	"POST /v1/workspaces/:workspaceId/agents/from-template": {
		summary: "Create an agent from a template",
		tags: ["Agents"],
		access: "agent.create",
		body: createFromTemplateSchema,
		status: 201,
	},
	"GET /v1/workspaces/:workspaceId/agents/:agentId/triggers": {
		summary: "What starts this agent when nobody is watching",
		tags: ["Agents"],
		access: "agent.read",
	},
	"POST /v1/workspaces/:workspaceId/agents/:agentId/triggers": {
		summary: "Add a webhook or a schedule. A webhook's secret is shown once",
		tags: ["Agents"],
		access: "agent.update",
		body: saveTriggerSchema,
		status: 201,
	},
	"PUT /v1/workspaces/:workspaceId/triggers/:triggerId": {
		summary: "Change a trigger",
		tags: ["Agents"],
		access: "agent.update",
		body: saveTriggerSchema,
	},
	"DELETE /v1/workspaces/:workspaceId/triggers/:triggerId": {
		summary: "Remove a trigger",
		tags: ["Agents"],
		access: "agent.update",
		status: 204,
	},
	"POST /v1/hooks/:triggerId": {
		summary: "Fire a webhook trigger. No session: the X-Ragenta-Secret header is the credential",
		tags: ["Agents"],
		access: "the webhook's own secret",
		status: 202,
	},
	"GET /v1/workspaces/:workspaceId/oauth-providers": {
		summary: "Which outside accounts can be connected on this deployment",
		tags: ["Agents"],
		access: "oauthConnection.read",
	},
	"GET /v1/workspaces/:workspaceId/oauth-connections": {
		summary: "Accounts this workspace has connected",
		tags: ["Agents"],
		access: "oauthConnection.read",
	},
	"GET /v1/workspaces/:workspaceId/data-sources": {
		summary: "Databases this workspace has connected, with their approved queries",
		tags: ["Agents"],
		access: "dataSource.read",
	},
	"GET /v1/workspaces/:workspaceId/widgets": {
		summary: "Embedded chats this workspace has published",
		tags: ["Agents"],
		access: "widget.read",
	},
	"PUT /v1/workspaces/:workspaceId/widgets": {
		summary: "Publish or change an embedded chat. The plan decides how many",
		tags: ["Agents"],
		access: "widget.manage",
		body: saveWidgetSchema,
	},
	"DELETE /v1/workspaces/:workspaceId/widgets/:widgetId": {
		summary: "Take an embedded chat down",
		tags: ["Agents"],
		access: "widget.manage",
		status: 204,
	},
	"GET /v1/widget/:publicKey/config": {
		summary: "What the embed page renders before anybody types. No session",
		tags: ["Embedded chat"],
		access: "a publishable key, from an allowed origin",
	},
	"POST /v1/widget/:publicKey/messages": {
		summary: "A visitor's message, answered over SSE. No session",
		tags: ["Embedded chat"],
		access: "a publishable key, from an allowed origin",
		body: widgetMessageSchema,
	},
	"PUT /v1/workspaces/:workspaceId/data-sources": {
		summary: "Connect a database. The engine is read from the connection string",
		tags: ["Agents"],
		access: "dataSource.manage",
		body: saveDataSourceSchema,
	},
	"POST /v1/workspaces/:workspaceId/data-sources/:sourceId/schema": {
		summary: "Read the tables and columns, and record whether the connection worked",
		tags: ["Agents"],
		access: "dataSource.manage",
	},
	"DELETE /v1/workspaces/:workspaceId/data-sources/:sourceId": {
		summary: "Remove a database connection and every query on it",
		tags: ["Agents"],
		access: "dataSource.manage",
		status: 204,
	},
	"POST /v1/workspaces/:workspaceId/data-queries/generate": {
		summary: "Propose a query from a plain-language description. Saves nothing",
		tags: ["Agents"],
		access: "dataSource.manage",
		body: generateQuerySchema,
	},
	"POST /v1/workspaces/:workspaceId/data-queries/dry-run": {
		summary: "Run a statement once so somebody can see what it returns before approving",
		tags: ["Agents"],
		access: "dataSource.manage",
		body: dryRunSchema,
	},
	"PUT /v1/workspaces/:workspaceId/data-queries": {
		summary: "Save a named query. A generated one stays unapproved until somebody approves it",
		tags: ["Agents"],
		access: "dataSource.manage",
		body: saveQuerySchema,
	},
	"DELETE /v1/workspaces/:workspaceId/data-queries/:queryId": {
		summary: "Remove a named query",
		tags: ["Agents"],
		access: "dataSource.manage",
		status: 204,
	},
	"GET /v1/workspaces/:workspaceId/api-keys": {
		summary: "The workspace's API keys and when each was last used",
		tags: ["Workspaces"],
		access: "apiKey.read",
	},
	"POST /v1/workspaces/:workspaceId/api-keys": {
		summary: "Create an API key. The key itself is in this response and no other",
		tags: ["Workspaces"],
		access: "apiKey.create",
		body: createApiKeySchema,
		status: 201,
	},
	"DELETE /v1/workspaces/:workspaceId/api-keys/:keyId": {
		summary: "Revoke an API key. The row is kept so the audit trail still points somewhere",
		tags: ["Workspaces"],
		access: "apiKey.revoke",
		status: 204,
	},
	"POST /v1/api/workspaces/:workspaceId/agents/:agentId/runs": {
		summary: "Queue an agent run. Authenticated by an API key, not a session",
		tags: ["Developer API"],
		access: "an API key holding agent.run",
	},
	"GET /v1/api/workspaces/:workspaceId/agents": {
		summary: "List agents, for a program",
		tags: ["Developer API"],
		access: "an API key holding agent.read",
	},
	"GET /v1/api/workspaces/:workspaceId/agent-runs/:runId": {
		summary: "How a queued run is getting on",
		tags: ["Developer API"],
		access: "an API key holding agentRun.read",
	},
	"GET /v1/api/workspaces/:workspaceId/agent-runs/:runId/steps": {
		summary: "What a run actually did, step by step",
		tags: ["Developer API"],
		access: "an API key holding agentRun.read",
	},
	"POST /v1/workspaces/:workspaceId/oauth-connections/:provider/start": {
		summary: "Begin connecting an account. Returns the URL to send the browser to",
		tags: ["Agents"],
		access: "oauthConnection.manage",
		body: startOAuthSchema,
	},
	"DELETE /v1/workspaces/:workspaceId/oauth-connections/:connectionId": {
		summary: "Disconnect an account",
		tags: ["Agents"],
		access: "oauthConnection.manage",
		status: 204,
	},
	"GET /v1/oauth/:provider/callback": {
		summary: "Where the provider sends the browser back. Redirects to the app",
		tags: ["Agents"],
		access: "the session that started the authorization",
	},
	"GET /v1/admin/oauth-providers": {
		summary: "The deployment's registered OAuth apps, with each redirect URI",
		tags: ["Admin"],
		access: "admin.oauth.read",
	},
	"PUT /v1/admin/oauth-providers/:provider": {
		summary: "Register an OAuth app's client id and secret",
		tags: ["Admin"],
		access: "admin.oauth.manage",
		body: saveOAuthClientSchema,
	},
	"PUT /v1/workspaces/:workspaceId/mcp-servers": {
		summary: "Add or change an MCP server this workspace owns",
		tags: ["Agents"],
		access: "mcpServer.manage",
		body: saveMcpServerSchema,
	},
	"DELETE /v1/workspaces/:workspaceId/mcp-servers/:serverId": {
		summary: "Remove an MCP server this workspace owns",
		tags: ["Agents"],
		access: "mcpServer.manage",
		status: 204,
	},
	"POST /v1/workspaces/:workspaceId/mcp-servers/:serverId/check": {
		summary: "Ask this workspace's MCP server what tools it offers",
		tags: ["Agents"],
		access: "mcpServer.manage",
	},

	"GET /v1/workspaces/:workspaceId/billing/promo-codes": {
		summary: "Promo codes this workspace has redeemed",
		tags: ["Billing"],
		access: "any member",
	},
	"POST /v1/workspaces/:workspaceId/billing/promo-codes/redeem": {
		summary: "Redeem a promo code for this workspace",
		tags: ["Billing"],
		access: "promo.redeem",
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
