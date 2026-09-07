import { describe, expect, it } from "vitest"

import type { integration } from "../../db/schema/integration.schema"
import {
	canWorkspaceUse,
	chooseConnection,
	composeConnectionId,
	connectionCandidateIds,
	connectionName,
	presentConnection,
} from "./connection-scope"

type IntegrationRow = typeof integration.$inferSelect

function row(overrides: Partial<IntegrationRow> & { id: string }): IntegrationRow {
	return {
		organizationId: null,
		kind: "http_api",
		name: "CRM",
		description: null,
		enabled: true,
		baseUrl: "https://crm.example.test",
		encryptedSecret: null,
		secretHint: null,
		authHeader: null,
		authPrefix: "",
		allowedMethods: ["GET"],
		allowedPathPrefix: "",
		allowedRecipients: [],
		lastUsedAt: null,
		lastCheckedAt: null,
		lastCheckOk: null,
		lastCheckError: null,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		updatedBy: null,
		...overrides,
	}
}

/** A workspace-owned row, stored the way the repository stores one. */
function owned(workspaceId: string, slug: string, overrides: Partial<IntegrationRow> = {}) {
	return row({
		id: composeConnectionId(workspaceId, slug),
		organizationId: workspaceId,
		...overrides,
	})
}

describe("connection ids", () => {
	it("stores a workspace connection namespaced by its workspace", () => {
		expect(composeConnectionId("ws_acme", "crm")).toBe("ws_acme:crm")
	})

	it("gives back the name the agent uses, not the stored key", () => {
		expect(connectionName(owned("ws_acme", "crm"))).toBe("crm")
		expect(connectionName(row({ id: "tavily" }))).toBe("tavily")
	})

	it("lets two workspaces both call their connection `crm`", () => {
		expect(composeConnectionId("ws_acme", "crm")).not.toBe(
			composeConnectionId("ws_globex", "crm"),
		)
	})

	it("looks up the workspace's own id first, then the platform-wide one", () => {
		expect(connectionCandidateIds("crm", "ws_acme")).toEqual(["ws_acme:crm", "crm"])
	})

	it("looks up only the platform-wide id when there is no workspace", () => {
		expect(connectionCandidateIds("crm")).toEqual(["crm"])
	})
})

describe("which connections a workspace may use", () => {
	const platform = row({ id: "tavily", organizationId: null })
	const mine = owned("ws_acme", "crm")
	const theirs = owned("ws_globex", "crm")

	it("accepts a platform-wide connection from any workspace", () => {
		expect(canWorkspaceUse(platform, "ws_acme")).toBe(true)
		expect(canWorkspaceUse(platform, "ws_globex")).toBe(true)
		expect(canWorkspaceUse(platform, undefined)).toBe(true)
	})

	it("accepts the workspace's own connection", () => {
		expect(canWorkspaceUse(mine, "ws_acme")).toBe(true)
	})

	it("refuses another workspace's connection", () => {
		expect(canWorkspaceUse(theirs, "ws_acme")).toBe(false)
		expect(canWorkspaceUse(mine, "ws_globex")).toBe(false)
	})

	it("refuses every workspace-owned connection when there is no workspace", () => {
		expect(canWorkspaceUse(mine, undefined)).toBe(false)
		expect(canWorkspaceUse(theirs, undefined)).toBe(false)
	})

	it("never resolves another workspace's row, even if the query handed one over", () => {
		// Belt and braces: the repository filters on the owner in SQL, and this
		// asserts the rule holds anyway if a future caller passes rows it should
		// not have. A leak here would be one workspace using another's key.
		expect(chooseConnection([theirs], "crm", "ws_acme")).toBeUndefined()
	})

	it("resolves nothing when a name is crafted to look like another tenant's key", () => {
		// The model chooses this string. `ws_globex:crm` composes to
		// `ws_acme:ws_globex:crm`, which does not exist, and the bare form is
		// rejected because the row is not platform-wide.
		expect(connectionCandidateIds("ws_globex:crm", "ws_acme")).toEqual([
			"ws_acme:ws_globex:crm",
			"ws_globex:crm",
		])
		expect(chooseConnection([theirs], "ws_globex:crm", "ws_acme")).toBeUndefined()
	})
})

describe("resolving a name to one connection", () => {
	const platformEmail = row({ id: "email", kind: "email", organizationId: null })
	const ownEmail = owned("ws_acme", "email", { kind: "email" })
	const theirEmail = owned("ws_globex", "email", { kind: "email" })

	it("prefers the workspace's own connection over the platform-wide one", () => {
		const chosen = chooseConnection([platformEmail, ownEmail], "email", "ws_acme")

		expect(chosen?.id).toBe("ws_acme:email")
	})

	it("falls back to the platform-wide connection when the workspace has none", () => {
		const chosen = chooseConnection([platformEmail], "email", "ws_acme")

		expect(chosen?.id).toBe("email")
	})

	it("does not let another workspace's row shadow the platform-wide one", () => {
		const chosen = chooseConnection([platformEmail, theirEmail], "email", "ws_acme")

		expect(chosen?.id).toBe("email")
	})

	it("sees only platform-wide rows when there is no workspace", () => {
		expect(chooseConnection([platformEmail, ownEmail], "email")?.id).toBe("email")
		expect(chooseConnection([ownEmail], "email")).toBeUndefined()
	})

	it("does not match a different name", () => {
		expect(chooseConnection([platformEmail, ownEmail], "crm", "ws_acme")).toBeUndefined()
	})
})

describe("what a response may say about a connection", () => {
	const secret = row({
		id: "tavily",
		kind: "web_search",
		encryptedSecret: "v1.aXY.dGFn.Y2lwaGVydGV4dA",
		secretHint: "tvl••••9f2c",
		authHeader: "Authorization",
		authPrefix: "Bearer ",
	})

	it("never carries the stored ciphertext, in any field", () => {
		const body = presentConnection(secret)

		expect(JSON.stringify(body)).not.toContain("v1.aXY.dGFn.Y2lwaGVydGV4dA")
		expect(Object.keys(body)).not.toContain("encryptedSecret")
	})

	it("says a secret is stored, and shows only the masked hint", () => {
		const body = presentConnection(secret)

		expect(body.hasSecret).toBe(true)
		expect(body.secretHint).toBe("tvl••••9f2c")
	})

	it("reports no secret rather than an empty one when none is stored", () => {
		const body = presentConnection(row({ id: "crm" }))

		expect(body).toMatchObject({ hasSecret: false, secretHint: null })
	})

	it("labels who owns the connection and names it the way an agent would", () => {
		expect(presentConnection(secret)).toMatchObject({ id: "tavily", scope: "platform" })
		expect(presentConnection(owned("ws_acme", "crm"))).toMatchObject({
			id: "crm",
			scope: "workspace",
		})
	})

	it("still hides the ciphertext of a workspace's own connection", () => {
		const body = presentConnection(
			owned("ws_acme", "crm", { encryptedSecret: "v1.a.b.c", secretHint: "abc••••wxyz" }),
		)

		expect(JSON.stringify(body)).not.toContain("v1.a.b.c")
		expect(body.secretHint).toBe("abc••••wxyz")
	})
})
