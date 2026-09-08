import { Hono } from "hono"

import { rateLimit } from "../../api/middleware/rate-limit"
import { requireAuth } from "../../api/middleware/session"
import { requirePermission } from "../../api/middleware/require-permission"
import { workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { agentController } from "./agent.controller"

/**
 * Agents are workspace-visible, like conversations: an agent grounded in the
 * workspace's documents is workspace knowledge, and one nobody else can see is
 * one nobody else can fix.
 *
 * Publishing a version changes what every future run does, and running one
 * spends credits, so `viewer` can do neither.
 */
export const agentRoutes = new Hono<AppEnv>()

agentRoutes.use("*", requireAuth)


/**
 * Starting a run, resuming one and retrying one all put the same loop back on a
 * provider — a run is many calls, so this is the cheapest place in the product
 * to spend a lot of money quickly. Stop is deliberately not counted: refusing a
 * request to stop spending is the wrong way round.
 */
const starting = rateLimit({
	name: "agent.run",
	limit: 20,
	windowSeconds: 60,
	message: "Too many runs started in a row. Wait a moment and try again.",
})

agentRoutes.get("/:workspaceId/agent-tools", workspaceScope, agentController.listTools)
agentRoutes.get("/:workspaceId/agents", workspaceScope, agentController.list)
agentRoutes.post(
	"/:workspaceId/agents",
	workspaceScope,
	requirePermission("agent.create"),
	agentController.create,
)
agentRoutes.get("/:workspaceId/agents/:agentId", workspaceScope, agentController.get)
agentRoutes.patch(
	"/:workspaceId/agents/:agentId",
	workspaceScope,
	requirePermission("agent.update"),
	agentController.update,
)
agentRoutes.delete(
	"/:workspaceId/agents/:agentId",
	workspaceScope,
	requirePermission("agent.delete"),
	agentController.remove,
)
agentRoutes.get(
	"/:workspaceId/agents/:agentId/versions",
	workspaceScope,
	agentController.listVersions,
)
agentRoutes.post(
	"/:workspaceId/agents/:agentId/versions",
	workspaceScope,
	requirePermission("agent.publish"),
	agentController.publishVersion,
)
agentRoutes.get("/:workspaceId/agents/:agentId/runs", workspaceScope, agentController.listRuns)
agentRoutes.post(
	"/:workspaceId/agents/:agentId/runs",
	workspaceScope,
	requirePermission("agent.run"),
	starting,
	agentController.run,
)
agentRoutes.post(
	"/:workspaceId/agents/:agentId/runs/queue",
	workspaceScope,
	requirePermission("agent.run"),
	starting,
	agentController.queueRun,
)
agentRoutes.get("/:workspaceId/agent-runs/:runId", workspaceScope, agentController.getRun)
agentRoutes.get("/:workspaceId/agent-runs/:runId/steps", workspaceScope, agentController.listSteps)
agentRoutes.post(
	"/:workspaceId/agent-runs/:runId/resume",
	workspaceScope,
	requirePermission("agentRun.control"),
	starting,
	agentController.resumeRun,
)
agentRoutes.post(
	"/:workspaceId/agent-runs/:runId/stop",
	workspaceScope,
	requirePermission("agentRun.control"),
	agentController.stopRun,
)
agentRoutes.post(
	"/:workspaceId/agent-runs/:runId/retry",
	workspaceScope,
	requirePermission("agentRun.control"),
	starting,
	agentController.retryRun,
)
