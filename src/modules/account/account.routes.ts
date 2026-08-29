import { Hono } from "hono"

import { requireAuth } from "../../api/middleware/session"
import type { AppEnv } from "../../api/types"
import { requireUser } from "../../api/types"
import { workspaceRepository } from "../workspace/workspace.repository"

/**
 * The current caller's own view of themselves. Profile mutations stay with
 * Better Auth (`/v1/auth/update-user`) — duplicating them here would mean two
 * code paths writing the identity tables.
 */
export const accountRoutes = new Hono<AppEnv>()

accountRoutes.use("*", requireAuth)

accountRoutes.get("/", async (c) => {
	const user = requireUser(c)
	const session = c.get("session")

	return c.json({
		user: {
			id: user.id,
			name: user.name,
			email: user.email,
			emailVerified: user.emailVerified,
			image: user.image,
			createdAt: user.createdAt,
		},
		activeWorkspaceId: session?.activeOrganizationId ?? null,
	})
})

accountRoutes.get("/workspaces", async (c) => {
	const user = requireUser(c)
	return c.json({ workspaces: await workspaceRepository.listForUser(user.id) })
})
