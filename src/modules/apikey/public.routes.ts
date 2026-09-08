import { Hono } from "hono"

import { attachApiKey, apiKeyWorkspaceScope } from "../../api/middleware/api-key"
import { rateLimit } from "../../api/middleware/rate-limit"
import { requirePermission } from "../../api/middleware/require-permission"
import type { AppEnv } from "../../api/types"
import { agentController } from "../agent/agent.controller"

/**
 * The developer API — what an API key can reach.
 *
 * A **separate router**, not the same routes with a second way in. Two reasons,
 * and the second is the one that matters:
 *
 *  - The product routes assume a session and a `workspaceScope` that queries
 *    membership. A key is already resolved to one membership, so it needs a
 *    different scope check, not the same one made lenient.
 *  - **It is a deliberately small surface.** Every route added here is one a
 *    leaked key can reach forever after. Adding "just this one" to a router the
 *    session also uses is how that surface grows without anybody deciding it
 *    should (ADR-062).
 *
 * What is *not* here is as considered as what is: no key management, so a leaked
 * key cannot mint a longer-lived one or widen its own reach; no billing; no
 * member administration.
 */
export const publicApiRoutes = new Hono<AppEnv>()

publicApiRoutes.use("*", attachApiKey)

/**
 * Counted per key rather than per user, exactly as ADR-045 said it would be when
 * keys arrived. A key is a program, and a program in a loop is the caller this
 * limiter exists for.
 */
publicApiRoutes.use(
	"*",
	rateLimit({
		name: "api.key",
		limit: 120,
		windowSeconds: 60,
		message: "This API key is making too many requests. Slow down and try again.",
	}),
)

publicApiRoutes.post(
	"/workspaces/:workspaceId/agents/:agentId/runs",
	apiKeyWorkspaceScope,
	requirePermission("agent.run"),
	// Queued rather than streamed: a program wants a run id back and a status to
	// poll, not to hold a connection open through a model loop.
	agentController.queueRun,
)

publicApiRoutes.get(
	"/workspaces/:workspaceId/agent-runs/:runId",
	apiKeyWorkspaceScope,
	requirePermission("agentRun.read"),
	agentController.getRun,
)

publicApiRoutes.get(
	"/workspaces/:workspaceId/agent-runs/:runId/steps",
	apiKeyWorkspaceScope,
	requirePermission("agentRun.read"),
	agentController.listSteps,
)

publicApiRoutes.get(
	"/workspaces/:workspaceId/agents",
	apiKeyWorkspaceScope,
	requirePermission("agent.read"),
	agentController.list,
)
