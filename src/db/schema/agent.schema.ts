import { relations, sql } from "drizzle-orm"
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"

import { user } from "./auth.schema"
import { project } from "./project.schema"
import { organization } from "./workspace.schema"

/**
 * An agent: a saved configuration — instructions, model, knowledge bases,
 * retrieval settings — that a workspace runs on demand.
 *
 * This row is only the stable identity that a URL, a schedule and an API caller
 * point at. What the agent actually *does* lives in `agent_version`, and every
 * run records the version it ran, so an answer stays explainable after the agent
 * has been edited (ADR-029).
 */
export const agent = pgTable(
	"agent",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/**
		 * Attribution only: a run's spend is reported under this project. Set null
		 * on delete — an agent outlives the project it was filed under.
		 */
		projectId: text("project_id").references(() => project.id, { onDelete: "set null" }),
		name: text("name").notNull(),
		description: text("description"),
		/** draft | active | archived. Only an active agent may be run. */
		status: text("status").default("draft").notNull(),
		/**
		 * Which `agent_version.version` is current. A plain integer rather than a
		 * foreign key to the version row, because the two tables would otherwise
		 * reference each other in a cycle no insert order can satisfy.
		 *
		 * Never null: creating an agent writes version 1 in the same transaction,
		 * so "an agent with nothing to run" is not a state that exists.
		 */
		currentVersion: integer("current_version").notNull(),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex("agent_organizationId_name_uidx").on(table.organizationId, table.name),
		index("agent_organizationId_updatedAt_idx").on(table.organizationId, table.updatedAt),
		check("agent_status_check", sql`${table.status} in ('draft', 'active', 'archived')`),
	],
)

/**
 * One immutable configuration of an agent. Editing an agent writes a new row and
 * moves `agent.current_version`; nothing here is ever updated in place.
 *
 * That is what makes a run auditable months later, and it is the precondition
 * for letting an agent be triggered by a schedule or an API key — both of which
 * run without anyone watching, against whatever the configuration was at the
 * time.
 */
export const agentVersion = pgTable(
	"agent_version",
	{
		id: text("id").primaryKey(),
		agentId: text("agent_id")
			.notNull()
			.references(() => agent.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),

		instructions: text("instructions").notNull(),

		/**
		 * Null inherits the resolution chain the rest of the product uses —
		 * project override, then workspace default (`modelService.resolveChatModel`).
		 * Stored as a pair or not at all; a provider without a model is meaningless.
		 */
		provider: text("provider"),
		model: text("model"),
		/** Null sends no temperature at all, which is what chat does today. */
		temperature: numeric("temperature", { precision: 3, scale: 2 }),
		maxOutputTokens: integer("max_output_tokens"),

		/**
		 * The knowledge bases this version searches. Empty means the agent answers
		 * without retrieval.
		 *
		 * Deliberately not a join table with foreign keys: a version is a frozen
		 * record of what was configured, and deleting a knowledge base must not
		 * rewrite it. The runner resolves the ids at run time and reports the ones
		 * that have since disappeared rather than failing the run.
		 */
		knowledgeBaseIds: jsonb("knowledge_base_ids").$type<string[]>().default([]).notNull(),

		/** hybrid | vector | keyword, matching `conversation.search_mode`. */
		searchMode: text("search_mode").default("hybrid").notNull(),
		/** Null inherits the knowledge base's own value, as a conversation does. */
		topK: integer("top_k"),
		similarityThreshold: numeric("similarity_threshold", { precision: 4, scale: 3 }),
		vectorWeight: numeric("vector_weight", { precision: 4, scale: 3 }),
		rerankProvider: text("rerank_provider"),
		rerankModel: text("rerank_model"),
		/** Whether an answer may leave the documents. See `conversation.grounded_only`. */
		groundedOnly: boolean("grounded_only").default(true).notNull(),

		/**
		 * Which tools a run of this version may call, by id.
		 *
		 * This is a security boundary, not a preference: the run builds its tool
		 * set from here and from nothing the caller or the model sent. An id this
		 * deployment does not know is refused when the version is published.
		 */
		tools: jsonb("tools").$type<string[]>().default([]).notNull(),
		/** How many model↔tool rounds a run may take. 1 = no tool loop. */
		maxRounds: integer("max_rounds").default(1).notNull(),
		/**
		 * The most credits one run of this version may spend before it is stopped.
		 *
		 * A tool loop can call the model many times, and a model that keeps
		 * deciding to search one more time would otherwise be bounded only by
		 * `max_rounds` — which says nothing about cost, because one round on a
		 * premium model with a full context is not one round on a cheap one. Null
		 * means only `max_rounds` bounds the run.
		 */
		creditCeiling: numeric("credit_ceiling", { precision: 14, scale: 4 }),

		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("agentVersion_agentId_version_uidx").on(table.agentId, table.version),
		check(
			"agentVersion_searchMode_check",
			sql`${table.searchMode} in ('hybrid', 'vector', 'keyword')`,
		),
	],
)

/**
 * One execution of one version.
 *
 * `credits` is a denormalised total for the run list — the authority is still
 * `usage_ledger`, one row per model call, which is what a customer is actually
 * billed from (ADR-029).
 */
export const agentRun = pgTable(
	"agent_run",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		agentId: text("agent_id")
			.notNull()
			.references(() => agent.id, { onDelete: "cascade" }),
		agentVersionId: text("agent_version_id")
			.notNull()
			.references(() => agentVersion.id, { onDelete: "restrict" }),
		projectId: text("project_id").references(() => project.id, { onDelete: "set null" }),
		/** Null when a schedule or an API key started the run, not a person. */
		userId: text("user_id").references(() => user.id, { onDelete: "set null" }),

		/** manual | api | schedule. Only `manual` exists in Phase 1. */
		trigger: text("trigger").default("manual").notNull(),
		/** running | succeeded | failed | stopped. */
		status: text("status").default("running").notNull(),

		input: jsonb("input").$type<Record<string, unknown>>().default({}).notNull(),
		output: text("output"),
		/** The reason a run ended badly, in the words the client is shown. */
		error: text("error"),

		credits: numeric("credits", { precision: 14, scale: 4 }).default("0").notNull(),

		startedAt: timestamp("started_at").defaultNow().notNull(),
		finishedAt: timestamp("finished_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("agentRun_organizationId_createdAt_idx").on(table.organizationId, table.createdAt),
		index("agentRun_agentId_createdAt_idx").on(table.agentId, table.createdAt),
		check(
			"agentRun_status_check",
			sql`${table.status} in ('running', 'succeeded', 'failed', 'stopped')`,
		),
		check("agentRun_trigger_check", sql`${table.trigger} in ('manual', 'api', 'schedule')`),
	],
)

/**
 * One step inside a run: a retrieval, or a call to the model.
 *
 * `usage_reference` is the same string as the matching `usage_ledger.reference`,
 * which carries a unique index — so a step that is retried cannot be charged
 * twice, and a run's steps can be joined back to exactly what was billed.
 */
export const agentRunStep = pgTable(
	"agent_run_step",
	{
		id: text("id").primaryKey(),
		runId: text("run_id")
			.notNull()
			.references(() => agentRun.id, { onDelete: "cascade" }),
		seq: integer("seq").notNull(),
		/** model | retrieval | tool. */
		kind: text("kind").notNull(),
		/** The tool's id on a `tool` step. Null on the others, which need no name. */
		name: text("name"),
		/** running | succeeded | failed. */
		status: text("status").default("running").notNull(),

		provider: text("provider"),
		model: text("model"),
		inputTokens: integer("input_tokens").default(0).notNull(),
		outputTokens: integer("output_tokens").default(0).notNull(),
		credits: numeric("credits", { precision: 14, scale: 4 }).default("0").notNull(),
		/** Matches `usage_ledger.reference`. Null for a step that costs nothing. */
		usageReference: text("usage_reference"),

		input: jsonb("input").$type<Record<string, unknown>>().default({}).notNull(),
		output: jsonb("output").$type<Record<string, unknown>>().default({}).notNull(),
		error: text("error"),

		startedAt: timestamp("started_at").defaultNow().notNull(),
		finishedAt: timestamp("finished_at"),
	},
	(table) => [
		uniqueIndex("agentRunStep_runId_seq_uidx").on(table.runId, table.seq),
		check("agentRunStep_kind_check", sql`${table.kind} in ('model', 'retrieval', 'tool')`),
		check(
			"agentRunStep_status_check",
			sql`${table.status} in ('running', 'succeeded', 'failed')`,
		),
	],
)

export const agentRelations = relations(agent, ({ one, many }) => ({
	organization: one(organization, {
		fields: [agent.organizationId],
		references: [organization.id],
	}),
	project: one(project, { fields: [agent.projectId], references: [project.id] }),
	versions: many(agentVersion),
	runs: many(agentRun),
}))

export const agentVersionRelations = relations(agentVersion, ({ one, many }) => ({
	agent: one(agent, { fields: [agentVersion.agentId], references: [agent.id] }),
	runs: many(agentRun),
}))

export const agentRunRelations = relations(agentRun, ({ one, many }) => ({
	organization: one(organization, {
		fields: [agentRun.organizationId],
		references: [organization.id],
	}),
	agent: one(agent, { fields: [agentRun.agentId], references: [agent.id] }),
	version: one(agentVersion, {
		fields: [agentRun.agentVersionId],
		references: [agentVersion.id],
	}),
	project: one(project, { fields: [agentRun.projectId], references: [project.id] }),
	user: one(user, { fields: [agentRun.userId], references: [user.id] }),
	steps: many(agentRunStep),
}))

export const agentRunStepRelations = relations(agentRunStep, ({ one }) => ({
	run: one(agentRun, { fields: [agentRunStep.runId], references: [agentRun.id] }),
}))
