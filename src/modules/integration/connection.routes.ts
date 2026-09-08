import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requirePermission } from "../../api/middleware/require-permission"
import { workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { datasourceController } from "../datasource/datasource.controller"
import { oauthController } from "../oauth/oauth.controller"
import { connectionController } from "./integration.controller"

/**
 * A workspace's own connections to outside systems.
 *
 * Every member can see which connections exist, because that is what someone
 * configuring an agent's `api_call` tool has to know — and what they see is the
 * masked hint, never a key. Creating, changing, deleting or testing one is a
 * credential operation and a spending one: the test makes a live outbound call
 * with the stored secret. So those carry the same owner/admin guard as billing
 * and workspace settings.
 */
export const connectionRoutes = new Hono<AppEnv>()

connectionRoutes.use("*", requireAuth)


connectionRoutes.get("/:workspaceId/connections", workspaceScope, connectionController.list)
connectionRoutes.get(
	"/:workspaceId/connections/:connectionId",
	workspaceScope,
	connectionController.get,
)
connectionRoutes.put(
	"/:workspaceId/connections/:connectionId",
	workspaceScope,
	requirePermission("connection.manage"),
	connectionController.save,
)
connectionRoutes.delete(
	"/:workspaceId/connections/:connectionId",
	workspaceScope,
	requirePermission("connection.manage"),
	connectionController.remove,
)
connectionRoutes.post(
	"/:workspaceId/connections/:connectionId/check",
	workspaceScope,
	requirePermission("connection.manage"),
	connectionController.check,
)

/**
 * Accounts somebody connected, which an agent then acts as.
 *
 * Beside the connections they sit next to on screen, and gated the same way: a
 * read is any member, and connecting one is the audience that manages every
 * other credential here (ADR-059).
 */
connectionRoutes.get(
	"/:workspaceId/oauth-providers",
	workspaceScope,
	requirePermission("oauthConnection.read"),
	oauthController.listProviders,
)
connectionRoutes.get(
	"/:workspaceId/oauth-connections",
	workspaceScope,
	requirePermission("oauthConnection.read"),
	oauthController.list,
)
connectionRoutes.post(
	"/:workspaceId/oauth-connections/:provider/start",
	workspaceScope,
	requirePermission("oauthConnection.manage"),
	oauthController.start,
)
connectionRoutes.delete(
	"/:workspaceId/oauth-connections/:connectionId",
	workspaceScope,
	requirePermission("oauthConnection.manage"),
	oauthController.disconnect,
)

/**
 * Databases an agent may look things up in, and the queries it may run.
 *
 * Reading is any member — the agent screen has to name the queries an agent can
 * call. Writing or approving one is the audience that manages every other
 * credential here, because approving a query decides what SQL runs against a
 * customer's own database (ADR-064).
 */
connectionRoutes.get(
	"/:workspaceId/data-sources",
	workspaceScope,
	requirePermission("dataSource.read"),
	datasourceController.list,
)
connectionRoutes.put(
	"/:workspaceId/data-sources",
	workspaceScope,
	requirePermission("dataSource.manage"),
	datasourceController.saveSource,
)
connectionRoutes.post(
	"/:workspaceId/data-sources/:sourceId/schema",
	workspaceScope,
	requirePermission("dataSource.manage"),
	datasourceController.refreshSchema,
)
connectionRoutes.delete(
	"/:workspaceId/data-sources/:sourceId",
	workspaceScope,
	requirePermission("dataSource.manage"),
	datasourceController.removeSource,
)

connectionRoutes.post(
	"/:workspaceId/data-queries/generate",
	workspaceScope,
	requirePermission("dataSource.manage"),
	datasourceController.generateQuery,
)
connectionRoutes.post(
	"/:workspaceId/data-queries/dry-run",
	workspaceScope,
	requirePermission("dataSource.manage"),
	datasourceController.dryRun,
)
connectionRoutes.put(
	"/:workspaceId/data-queries",
	workspaceScope,
	requirePermission("dataSource.manage"),
	datasourceController.saveQuery,
)
connectionRoutes.delete(
	"/:workspaceId/data-queries/:queryId",
	workspaceScope,
	requirePermission("dataSource.manage"),
	datasourceController.removeQuery,
)
