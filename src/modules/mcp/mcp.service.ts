import type { McpToolSummary } from "../../db/schema/mcp.schema"
import { callTool, listTools } from "../../mcp/client"
import type { McpEndpoint } from "../../mcp/client"
import { decryptSecret, encryptSecret, maskSecret } from "../../shared/crypto"
import { NotFoundError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import { mcpRepository } from "./mcp.repository"
import { parseMcpToolId } from "./tool-id"
import type { McpToolId } from "./tool-id"
import type { SaveMcpServerInput } from "./mcp.dto"
import type { McpServerRow } from "./mcp.repository"

const log = logger.child({ module: "mcp" })

export { isMcpToolId, mcpWireName, parseMcpToolId } from "./tool-id"
export type { McpToolId } from "./tool-id"

/** How long a discovered tool list is trusted before it is fetched again. */
const CACHE_TTL_MS = 10 * 60 * 1000

function endpointFor(row: McpServerRow): McpEndpoint {
	return {
		url: row.url,
		secret: row.encryptedSecret ? decryptSecret(row.encryptedSecret) : null,
		authHeader: row.authHeader,
		authPrefix: row.authPrefix,
	}
}

/**
 * Whether a server is allowed to offer this tool.
 *
 * An empty allowlist means every tool the server advertises — and that is the
 * choice the screen has to make visible, because a server that starts
 * advertising `delete_everything` after somebody approved it for `search_docs`
 * would otherwise gain that reach with nobody deciding anything.
 */
function allows(row: McpServerRow, tool: string): boolean {
	return row.allowedTools.length === 0 || row.allowedTools.includes(tool)
}

export const mcpService = {
	async listForWorkspace(workspaceId: string) {
		const rows = await mcpRepository.listForWorkspace(workspaceId)
		return rows.map(toPublic)
	},

	/**
	 * The tools a workspace's servers advertise, as ids a version can store.
	 *
	 * Served from the cached list rather than by calling every server: this is
	 * read by the screen that offers tools, and a page load should not fan out to
	 * every third-party server a workspace has configured.
	 */
	async listAvailableTools(workspaceId: string) {
		const rows = await mcpRepository.listForWorkspace(workspaceId)

		return rows
			.filter((row) => row.enabled)
			.flatMap((row) =>
				row.toolsCache.filter((tool) => allows(row, tool.name)).map((tool) => ({
					id: `mcp:${row.slug}:${tool.name}`,
					server: row.slug,
					serverName: row.name,
					name: tool.name,
					description: tool.description,
					// Stale is worth saying: a tool list nobody has refreshed since the
					// server changed is the reason a call will fail, and the screen can
					// only offer a "refresh" button if it knows.
					discoveredAt: row.toolsCachedAt,
				})),
			)
	},

	/**
	 * Fetches the server's tool list and caches it.
	 *
	 * The outcome is recorded on the row either way — a server that has been
	 * unreachable for a week is something an operator should be able to see
	 * without reading logs, exactly as `provider_credential` records its check.
	 */
	async discover(serverId: string, signal?: AbortSignal): Promise<McpToolSummary[]> {
		const row = await mcpRepository.findById(serverId)
		if (!row) throw new NotFoundError("MCP server")

		try {
			const tools = await listTools(endpointFor(row), signal)
			const summaries: McpToolSummary[] = tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
			}))

			await mcpRepository.cacheTools(row.id, summaries)
			await mcpRepository.update(row.id, {
				lastCheckedAt: new Date(),
				lastCheckOk: true,
				lastCheckError: null,
			})

			log.info("mcp.discovered", { server: row.slug, tools: summaries.length })
			return summaries
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			await mcpRepository.update(row.id, {
				lastCheckedAt: new Date(),
				lastCheckOk: false,
				lastCheckError: message.slice(0, 500),
			})
			throw error
		}
	},

	/**
	 * The tool list a run should work from.
	 *
	 * Refreshed when the cache is older than the TTL, and falling back to the
	 * stale list when the refresh fails: a server that is briefly down should not
	 * make an agent forget which tools it had. The failure is recorded on the row.
	 */
	async toolsForRun(row: McpServerRow, signal?: AbortSignal): Promise<McpToolSummary[]> {
		const age = row.toolsCachedAt ? Date.now() - row.toolsCachedAt.getTime() : Infinity
		if (age < CACHE_TTL_MS) return row.toolsCache

		try {
			return await mcpService.discover(row.id, signal)
		} catch (error) {
			log.warn("mcp.refresh_failed", { server: row.slug, error: String(error) })
			return row.toolsCache
		}
	},

	/**
	 * Runs one tool on one server.
	 *
	 * Three things are checked before the call, and none of them comes from the
	 * model: that the server is one this workspace may reach, that it is enabled,
	 * and that the tool is on its allowlist. The model chose only which of the
	 * ids it was given to call.
	 */
	async call(
		workspaceId: string,
		id: McpToolId,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	) {
		const row = await mcpRepository.findBySlugForWorkspace(workspaceId, id.slug)
		if (!row) throw new NotFoundError("MCP server")
		if (!row.enabled) {
			throw new ValidationError(`The ${row.name} server is turned off on this deployment.`)
		}
		if (!allows(row, id.tool)) {
			throw new ValidationError(`${id.tool} is not on the allowlist for ${row.name}.`)
		}

		return callTool(endpointFor(row), id.tool, args, signal)
	},

	/** Refuses a version naming a server or tool this workspace cannot reach. */
	async assertToolAvailable(workspaceId: string, toolId: string): Promise<void> {
		const parsed = parseMcpToolId(toolId)
		if (!parsed) throw new ValidationError(`${toolId} is not a valid MCP tool id.`)

		const row = await mcpRepository.findBySlugForWorkspace(workspaceId, parsed.slug)
		if (!row) throw new ValidationError(`No MCP server called ${parsed.slug} is configured.`)
		if (!allows(row, parsed.tool)) {
			throw new ValidationError(`${parsed.tool} is not on the allowlist for ${row.name}.`)
		}
	},

	async findForWorkspace(workspaceId: string, slug: string) {
		return mcpRepository.findBySlugForWorkspace(workspaceId, slug)
	},

	/** Platform-wide servers, for the console. */
	async listPlatform() {
		return (await mcpRepository.listPlatform()).map(toPublic)
	},

	/**
	 * Creates or replaces a server.
	 *
	 * `organizationId` comes from the caller's proven scope, never from the body:
	 * it decides which tenant owns the row and which tenants may reach it.
	 *
	 * An omitted secret keeps the stored one; `null` clears it. A form that
	 * resubmits without the field must not silently delete a credential, and
	 * there has to be a way to say there is none.
	 */
	async save(
		organizationId: string | null,
		input: SaveMcpServerInput,
		actorId: string,
	) {
		const existing = organizationId
			? (await mcpRepository.listForWorkspace(organizationId)).find(
					(row) => row.slug === input.slug && row.organizationId === organizationId,
				)
			: (await mcpRepository.listPlatform()).find((row) => row.slug === input.slug)

		const secretFields =
			input.secret === undefined
				? {}
				: input.secret === null
					? { encryptedSecret: null, secretHint: null }
					: { encryptedSecret: encryptSecret(input.secret), secretHint: maskSecret(input.secret) }

		const id = existing?.id ?? newId()

		await mcpRepository.upsert({
			id,
			organizationId,
			slug: input.slug,
			name: input.name,
			description: input.description,
			url: input.url,
			enabled: input.enabled,
			authHeader: input.authHeader,
			authPrefix: input.authPrefix,
			allowedTools: input.allowedTools,
			// A changed URL invalidates what the old one advertised. Keeping the
			// cache would offer tools from a server nobody is talking to any more.
			...(existing && existing.url === input.url
				? {}
				: { toolsCache: [], toolsCachedAt: null }),
			...secretFields,
			updatedBy: actorId,
		})

		log.info("mcp.saved", { server: input.slug, workspace: organizationId })

		const saved = await mcpRepository.findById(id)
		return saved ? toPublic(saved) : undefined
	},

	/**
	 * A workspace may only change a row it owns.
	 *
	 * A platform-wide server is one every tenant can reach; letting one of them
	 * edit or delete it would let one customer turn off another's tools. The
	 * refusal is 404 rather than 403 for a row belonging to somebody else, and a
	 * plain explanation for a platform-wide one — that row is not a secret, it is
	 * just not theirs.
	 */
	async requireOwnedBy(organizationId: string, serverId: string): Promise<McpServerRow> {
		const row = await mcpRepository.findById(serverId)
		if (!row) throw new NotFoundError("MCP server")
		if (row.organizationId === null) {
			throw new ValidationError(
				"This server is configured for the whole deployment. Ask an administrator to change it.",
			)
		}
		if (row.organizationId !== organizationId) throw new NotFoundError("MCP server")
		return row
	},

	async removeScoped(organizationId: string, serverId: string): Promise<void> {
		const row = await mcpService.requireOwnedBy(organizationId, serverId)
		await mcpRepository.remove(row.id)
		log.info("mcp.removed", { server: row.slug, workspace: organizationId })
	},

	async checkScoped(organizationId: string, serverId: string) {
		const row = await mcpService.requireOwnedBy(organizationId, serverId)
		return mcpService.checkPlatform(row.id)
	},

	async removePlatform(serverId: string): Promise<void> {
		const row = await mcpRepository.findById(serverId)
		if (!row) throw new NotFoundError("MCP server")
		await mcpRepository.remove(serverId)
		log.info("mcp.removed", { server: row.slug })
	},

	/** Discovery as an explicit action, so a screen can show what came back. */
	async checkPlatform(serverId: string) {
		await mcpService.discover(serverId)
		const row = await mcpRepository.findById(serverId)
		if (!row) throw new NotFoundError("MCP server")
		return toPublic(row)
	},
}

/** The row as an API response: never the secret, only the masked hint (ADR-021). */
function toPublic(row: McpServerRow) {
	return {
		id: row.id,
		organizationId: row.organizationId,
		slug: row.slug,
		name: row.name,
		description: row.description,
		enabled: row.enabled,
		url: row.url,
		secretHint: row.secretHint,
		authHeader: row.authHeader,
		allowedTools: row.allowedTools,
		tools: row.toolsCache.map((tool) => ({ name: tool.name, description: tool.description })),
		toolsCachedAt: row.toolsCachedAt,
		lastCheckedAt: row.lastCheckedAt,
		lastCheckOk: row.lastCheckOk,
		lastCheckError: row.lastCheckError,
	}
}
