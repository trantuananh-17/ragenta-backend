import { Hono } from "hono"

import { rateLimit } from "../../api/middleware/rate-limit"
import { requireAuth } from "../../api/middleware/session"
import { requirePermission } from "../../api/middleware/require-permission"
import { requireResourcePermission } from "../../api/middleware/require-resource-permission"
import { workspaceScope } from "../../api/middleware/workspace-scope"
import type { AppEnv } from "../../api/types"
import { triggerController } from "../trigger/trigger.controller"
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

// Starting points, and creating an agent from one. Reading the list is open to
// any member for the same reason the tool list is: it describes the build.
agentRoutes.get(
	"/:workspaceId/agent-templates",
	workspaceScope,
	agentController.listTemplates,
)
agentRoutes.post(
	"/:workspaceId/agents/from-template",
	workspaceScope,
	requirePermission("agent.create"),
	agentController.createFromTemplate,
)
agentRoutes.post(
	"/:workspaceId/agents",
	workspaceScope,
	requirePermission("agent.create"),
	agentController.create,
)
agentRoutes.get(
	"/:workspaceId/agents/:agentId",
	workspaceScope,
	requireResourcePermission("agent.read", "agent", "agentId"),
	agentController.get,
)
agentRoutes.patch(
	"/:workspaceId/agents/:agentId",
	workspaceScope,
	requireResourcePermission("agent.update", "agent", "agentId"),
	agentController.update,
)
agentRoutes.delete(
	"/:workspaceId/agents/:agentId",
	workspaceScope,
	requireResourcePermission("agent.delete", "agent", "agentId"),
	agentController.remove,
)
agentRoutes.get(
	"/:workspaceId/agents/:agentId/versions",
	workspaceScope,
	requireResourcePermission("agent.read", "agent", "agentId"),
	agentController.listVersions,
)
agentRoutes.post(
	"/:workspaceId/agents/:agentId/versions",
	workspaceScope,
	requireResourcePermission("agent.publish", "agent", "agentId"),
	agentController.publishVersion,
)
agentRoutes.get(
	"/:workspaceId/agents/:agentId/runs",
	workspaceScope,
	requireResourcePermission("agent.read", "agent", "agentId"),
	agentController.listRuns,
)
agentRoutes.post(
	"/:workspaceId/agents/:agentId/runs",
	workspaceScope,
	requireResourcePermission("agent.run", "agent", "agentId"),
	starting,
	agentController.run,
)
agentRoutes.post(
	"/:workspaceId/agents/:agentId/runs/queue",
	workspaceScope,
	requireResourcePermission("agent.run", "agent", "agentId"),
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

/**
 * What starts a run when nobody is watching.
 *
 * Reading a trigger list is `agent.read` on that agent; creating or changing one
 * is `agent.update`, because a trigger makes an agent spend money on a schedule
 * somebody else set (ADR-058).
 */
agentRoutes.get(
	"/:workspaceId/agents/:agentId/triggers",
	workspaceScope,
	requireResourcePermission("agent.read", "agent", "agentId"),
	triggerController.list,
)
agentRoutes.post(
	"/:workspaceId/agents/:agentId/triggers",
	workspaceScope,
	requireResourcePermission("agent.update", "agent", "agentId"),
	triggerController.create,
)
agentRoutes.put(
	"/:workspaceId/triggers/:triggerId",
	workspaceScope,
	requirePermission("agent.update"),
	triggerController.update,
)
agentRoutes.delete(
	"/:workspaceId/triggers/:triggerId",
	workspaceScope,
	requirePermission("agent.update"),
	triggerController.remove,
)
