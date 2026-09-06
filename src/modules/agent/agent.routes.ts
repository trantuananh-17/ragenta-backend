import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import { requireWorkspaceRole, workspaceScope } from "../../api/middleware/workspace-scope"
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

const contributor = requireWorkspaceRole("owner", "admin", "member")

agentRoutes.get("/:workspaceId/agents", workspaceScope, agentController.list)
agentRoutes.post("/:workspaceId/agents", workspaceScope, contributor, agentController.create)
agentRoutes.get("/:workspaceId/agents/:agentId", workspaceScope, agentController.get)
agentRoutes.patch(
	"/:workspaceId/agents/:agentId",
	workspaceScope,
	contributor,
	agentController.update,
)
agentRoutes.delete(
	"/:workspaceId/agents/:agentId",
	workspaceScope,
	contributor,
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
	contributor,
	agentController.publishVersion,
)
agentRoutes.get("/:workspaceId/agents/:agentId/runs", workspaceScope, agentController.listRuns)
agentRoutes.post(
	"/:workspaceId/agents/:agentId/runs",
	workspaceScope,
	contributor,
	agentController.run,
)
agentRoutes.get("/:workspaceId/agent-runs/:runId", workspaceScope, agentController.getRun)
agentRoutes.get("/:workspaceId/agent-runs/:runId/steps", workspaceScope, agentController.listSteps)
agentRoutes.post(
	"/:workspaceId/agent-runs/:runId/stop",
	workspaceScope,
	contributor,
	agentController.stopRun,
)
