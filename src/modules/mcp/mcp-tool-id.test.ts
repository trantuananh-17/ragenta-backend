import { describe, expect, it } from "vitest"

import { isMcpToolId, mcpWireName, parseMcpToolId } from "./tool-id"

describe("the id an agent version stores for an MCP tool", () => {
	it("names the server as well as the tool", () => {
		expect(parseMcpToolId("mcp:linear:search_issues")).toEqual({
			slug: "linear",
			tool: "search_issues",
		})
	})

	/**
	 * The reason the server is in the id at all. Two servers will both advertise
	 * `search`, and a version that recorded only the tool name would silently
	 * start calling the other one the day somebody adds a second server.
	 */
	it("tells two servers' tools of the same name apart", () => {
		expect(parseMcpToolId("mcp:linear:search")).not.toEqual(parseMcpToolId("mcp:notion:search"))
	})

	it.each([
		"linear:search",
		"mcp:search",
		"mcp::search",
		"mcp:Linear:search",
		"mcp:-linear:search",
		"mcp:linear:",
		"mcp:linear:search issues",
		"mcp:linear:search;drop",
		"knowledge_search",
		"",
	])("refuses %j rather than guessing what it names", (value) => {
		expect(parseMcpToolId(value)).toBeUndefined()
		expect(isMcpToolId(value)).toBe(false)
	})

	it("does not mistake a built-in tool for an MCP one", () => {
		for (const id of ["knowledge_search", "http_request", "memory_write"]) {
			expect(isMcpToolId(id)).toBe(false)
		}
	})
})

describe("the name the model sees", () => {
	it("is derived from the id rather than stored beside it", () => {
		expect(mcpWireName({ slug: "linear", tool: "search_issues" })).toBe(
			"mcp_linear_search_issues",
		)
	})

	// Colons are not accepted in a tool name by every provider, and a dash is not
	// accepted by all of them either.
	it("carries no character a provider might refuse", () => {
		const name = mcpWireName({ slug: "my-server", tool: "do.thing" })
		expect(name).toBe("mcp_my_server_do.thing")
		expect(name).not.toContain(":")
		expect(name).not.toContain("-")
	})
})
