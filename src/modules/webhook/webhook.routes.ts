import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requirePermission } from "../../api/middleware/require-permission"
import { workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { webhookController } from "./webhook.controller"

/**
 * Where a workspace says it wants to be told about something.
 *
 * Reading is gated rather than open to every member, unlike connections: the
 * list carries the URLs a workspace posts its own data to, and that is closer to
 * an audit log than to a setting somebody configuring an agent needs to see.
 * Managing one is a credential operation — it mints a signing secret — so it
 * carries the same audience as every other credential here.
 */
export const webhookEndpointRoutes = new Hono<AppEnv>()

webhookEndpointRoutes.use("*", requireAuth)

webhookEndpointRoutes.get(
	"/:workspaceId/webhooks",
	workspaceScope,
	requirePermission("webhook.read"),
	webhookController.list,
)
webhookEndpointRoutes.post(
	"/:workspaceId/webhooks",
	workspaceScope,
	requirePermission("webhook.manage"),
	webhookController.create,
)
webhookEndpointRoutes.put(
	"/:workspaceId/webhooks/:endpointId",
	workspaceScope,
	requirePermission("webhook.manage"),
	webhookController.update,
)
webhookEndpointRoutes.post(
	"/:workspaceId/webhooks/:endpointId/rotate-secret",
	workspaceScope,
	requirePermission("webhook.manage"),
	webhookController.rotateSecret,
)
webhookEndpointRoutes.delete(
	"/:workspaceId/webhooks/:endpointId",
	workspaceScope,
	requirePermission("webhook.manage"),
	webhookController.remove,
)

/**
 * The delivery log. Readable by whoever may read the endpoints, because the
 * whole reason it exists is to settle "did you send it" — and somebody who
 * cannot see the answer cannot settle anything.
 */
webhookEndpointRoutes.get(
	"/:workspaceId/webhook-deliveries",
	workspaceScope,
	requirePermission("webhook.read"),
	webhookController.listDeliveries,
)
