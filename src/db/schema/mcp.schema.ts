import { relations, sql } from "drizzle-orm"
import {
	boolean,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"

import { user } from "./auth.schema"
import { organization } from "./workspace.schema"

/**
 * An MCP server this deployment may call.
 *
 * ADR-030 deferred the MCP client with a reason — it needs its own table, its
 * own credential handling and its own ADR — and this is that table. It follows
 * `integration` deliberately (ADR-042): one table with a nullable owner rather
 * than a platform table and a workspace table, because two credential systems
 * means two places a secret can leak and one of them becomes the one nobody
 * audits.
 *
 * **Remote servers only, over HTTP.** The MCP spec also defines a stdio
 * transport that runs the server as a child process; that is somebody else's
 * code executing inside the API container, which is the sandbox problem and not
 * this one (ADR-056).
 */
export const mcpServer = pgTable(
	"mcp_server",
	{
		id: text("id").primaryKey(),
		/** NULL means platform-wide and nameable by every workspace. */
		organizationId: text("organization_id").references(() => organization.id, {
			onDelete: "cascade",
		}),
		/**
		 * What the model sees in a tool name: `mcp:<slug>:<tool>`. Lower-case and
		 * dash-separated, because it has to survive being part of an identifier
		 * every provider accepts.
		 */
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		description: text("description").default("").notNull(),
		/** Off keeps the row and its key while making every call through it refuse. */
		enabled: boolean("enabled").default(true).notNull(),

		/** Where the server answers. Checked against the SSRF rules on every call. */
		url: text("url").notNull(),

		/**
		 * AES-256-GCM ciphertext, read only when a call is made and never selected
		 * into an API response — exactly as `integration` and `provider_credential`
		 * do it (ADR-021).
		 */
		encryptedSecret: text("encrypted_secret"),
		secretHint: text("secret_hint"),
		authHeader: text("auth_header").default("Authorization").notNull(),
		authPrefix: text("auth_prefix").default("Bearer ").notNull(),

		/**
		 * Which of the server's tools an agent may call. Empty means every tool the
		 * server advertises.
		 *
		 * The allowlist is the security boundary, not the prompt. A server that
		 * starts advertising `delete_everything` after somebody approved it for
		 * `search_docs` should not silently gain that reach — which is what an
		 * empty list accepts, and why the screen has to make that choice visible.
		 */
		allowedTools: jsonb("allowed_tools").$type<string[]>().default([]).notNull(),

		/**
		 * The last tool list this server advertised, and when.
		 *
		 * Cached because discovery is a network round trip and a run cannot afford
		 * one per turn — and kept on the row rather than in Redis because a stale
		 * cache here is a tool that silently disappears from an agent, which is
		 * worth being able to look at.
		 */
		toolsCache: jsonb("tools_cache").$type<McpToolSummary[]>().default([]).notNull(),
		toolsCachedAt: timestamp("tools_cached_at"),

		lastCheckedAt: timestamp("last_checked_at"),
		lastCheckOk: boolean("last_check_ok"),
		/** The far side's own failure message. Never contains the secret. */
		lastCheckError: text("last_check_error"),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
	},
	(table) => [
		// Two unique indexes rather than one: two NULLs are distinct in SQL, so a
		// single unique on (organization_id, slug) would accept a second
		// platform-wide server with the same slug — and the slug is what a tool
		// name resolves through.
		uniqueIndex("mcpServer_workspace_slug_uidx")
			.on(table.organizationId, table.slug)
			.where(sql`organization_id is not null`),
		uniqueIndex("mcpServer_platform_slug_uidx")
			.on(table.slug)
			.where(sql`organization_id is null`),
		index("mcpServer_organizationId_idx").on(table.organizationId),
	],
)

/** One tool as the server described it. Stored verbatim; never trusted as instruction. */
export interface McpToolSummary {
	name: string
	description: string
	inputSchema: Record<string, unknown>
}

export const mcpServerRelations = relations(mcpServer, ({ one }) => ({
	organization: one(organization, {
		fields: [mcpServer.organizationId],
		references: [organization.id],
	}),
	updatedByUser: one(user, { fields: [mcpServer.updatedBy], references: [user.id] }),
}))
