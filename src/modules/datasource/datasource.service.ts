import { z } from "zod"

import { providerClient } from "../../ai/clients"
import { env } from "../../config/env"
import { requireCredential } from "../../ai/catalogue"
import { introspect, runQuery } from "../../datasource/execute"
import { maskDsn, parseDsn, scrubDsns } from "../../datasource/dsn"
import { assertDsnHostAllowed } from "../../datasource/host-policy"
import type { DataQueryParameter, DataSourceTable } from "../../db/schema/datasource.schema"
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import { decryptSecret, encryptSecret } from "../../shared/crypto"
import { auditService } from "../audit/audit.service"
import { billingService } from "../billing/billing.service"
import { modelService } from "../model/model.service"
import { usageService } from "../usage/usage.service"
import { datasourceRepository } from "./datasource.repository"
import type { DataQueryRow, DataSourceRow } from "./datasource.repository"
import type { GenerateQueryInput, SaveDataSourceInput, SaveQueryInput } from "./datasource.dto"

const log = logger.child({ module: "datasource" })

/** How much of the schema a generation prompt may carry. */
const MAX_TABLES_IN_PROMPT = 40

export const datasourceService = {
	async list(workspaceId: string) {
		const sources = await datasourceRepository.listSources(workspaceId)
		return Promise.all(
			sources.map(async (source) => ({
				...toPublicSource(source),
				queries: (await datasourceRepository.listQueries(workspaceId, source.id)).map(
					toPublicQuery,
				),
			})),
		)
	},

	/**
	 * Saves a connection.
	 *
	 * The engine is read from the connection string rather than chosen in a form:
	 * a `postgres://` URL saved as MySQL is a confusing failure two screens later,
	 * and the scheme already says which it is.
	 */
	async saveSource(workspaceId: string, input: SaveDataSourceInput, actorId: string) {
		const existing = input.id
			? await datasourceRepository.findSource(workspaceId, input.id)
			: undefined
		if (input.id && !existing) throw new NotFoundError("Data source")

		// Only a new connection is gated. A workspace that downgrades keeps the
		// sources it has working, for the reason a widget keeps serving: cutting a
		// customer's agent off from their own database because a card expired is a
		// worse failure than one connection too many.
		if (!existing) {
			await billingService.assertPlanFeature(workspaceId, "dataSourcesEnabled")
		}

		let engine = existing?.engine
		let encryptedDsn = existing?.encryptedDsn
		let dsnHint = existing?.dsnHint

		if (input.dsn) {
			const parsed = parseDsn(input.dsn)
			if (!parsed) {
				throw new ValidationError(
					"That connection string could not be read. It should look like postgres://user:password@host:5432/database.",
				)
			}
			await assertDsnHostAllowed(input.dsn, env.datasource.allowPrivateHosts)
			engine = parsed.engine
			encryptedDsn = encryptSecret(input.dsn)
			dsnHint = maskDsn(input.dsn)
		}

		if (!engine || !encryptedDsn || !dsnHint) {
			throw new ValidationError("A connection string is needed.")
		}

		const duplicate = await datasourceRepository.findSourceByName(workspaceId, input.name)
		if (duplicate && duplicate.id !== existing?.id) {
			throw new ConflictError(`A data source called "${input.name}" already exists.`)
		}

		const id = existing?.id ?? newId()
		await datasourceRepository.upsertSource({
			id,
			organizationId: workspaceId,
			name: input.name,
			engine,
			encryptedDsn,
			dsnHint,
			enabled: input.enabled,
			// A changed connection invalidates the schema read from the old one.
			...(input.dsn ? { schemaCache: [], schemaCachedAt: null } : {}),
			createdBy: existing?.createdBy ?? actorId,
		})

		await auditService.record({
			action: "datasource.saved",
			actorId,
			organizationId: workspaceId,
			targetType: "data_source",
			targetId: id,
			// The hint, never the string. This row is kept for years.
			metadata: { name: input.name, engine, dsn: dsnHint },
		})

		const saved = await datasourceRepository.findSource(workspaceId, id)
		return saved ? toPublicSource(saved) : undefined
	},

	/**
	 * Connects, reads the schema and records the outcome.
	 *
	 * The outcome is stored either way, for the reason `provider_credential`
	 * stores its check: a data source that has been unreachable since Tuesday is
	 * something somebody should see on a screen rather than discover when an agent
	 * answers "I could not look that up".
	 */
	async refreshSchema(workspaceId: string, sourceId: string): Promise<DataSourceTable[]> {
		const source = await datasourceRepository.findSource(workspaceId, sourceId)
		if (!source) throw new NotFoundError("Data source")

		try {
			const tables = await introspect(source.engine as "postgres" | "mysql", decryptSecret(source.encryptedDsn))
			await datasourceRepository.updateSource(sourceId, {
				schemaCache: tables,
				schemaCachedAt: new Date(),
				lastCheckedAt: new Date(),
				lastCheckOk: true,
				lastCheckError: null,
			})
			log.info("datasource.schema_read", { sourceId, tables: tables.length })
			return tables
		} catch (error) {
			const message = scrubDsns(error instanceof Error ? error.message : String(error))
			await datasourceRepository.updateSource(sourceId, {
				lastCheckedAt: new Date(),
				lastCheckOk: false,
				lastCheckError: message.slice(0, 500),
			})
			throw new ValidationError(message)
		}
	},

	async removeSource(workspaceId: string, sourceId: string, actorId: string) {
		const source = await datasourceRepository.findSource(workspaceId, sourceId)
		if (!source) throw new NotFoundError("Data source")

		await datasourceRepository.removeSource(sourceId)
		await auditService.record({
			action: "datasource.removed",
			actorId,
			organizationId: workspaceId,
			targetType: "data_source",
			targetId: sourceId,
			metadata: { name: source.name },
		})
	},

	/**
	 * Saves a named query.
	 *
	 * A hand-written one is **approved by the act of saving it**: the person who
	 * typed the SQL is the person reviewing it, and asking them to approve their
	 * own work twice teaches everybody to click through approvals. A *generated*
	 * one is saved unapproved and stays invisible to every agent until somebody
	 * has seen it run (ADR-064).
	 */
	async saveQuery(workspaceId: string, input: SaveQueryInput, actorId: string) {
		const source = await datasourceRepository.findSource(workspaceId, input.dataSourceId)
		if (!source) throw new NotFoundError("Data source")

		const existing = input.id
			? await datasourceRepository.findQuery(workspaceId, input.id)
			: undefined
		if (input.id && !existing) throw new NotFoundError("Query")

		const duplicate = await datasourceRepository.findQueryByName(source.id, input.name)
		if (duplicate && duplicate.id !== existing?.id) {
			throw new ConflictError(`A query called "${input.name}" already exists on this source.`)
		}

		const id = existing?.id ?? newId()
		const approving = input.origin === "manual" || input.approve === true

		await datasourceRepository.upsertQuery({
			id,
			organizationId: workspaceId,
			dataSourceId: source.id,
			name: input.name,
			description: input.description,
			sql: input.sql,
			parameters: input.parameters,
			rowLimit: input.rowLimit,
			origin: input.origin,
			approvedAt: approving ? new Date() : null,
			approvedBy: approving ? actorId : null,
			createdBy: existing?.createdBy ?? actorId,
		})

		await auditService.record({
			action: approving ? "datasource.query.approved" : "datasource.query.saved",
			actorId,
			organizationId: workspaceId,
			targetType: "data_query",
			targetId: id,
			// The statement is audited: this is the one thing an agent can cause to
			// run against a customer's database, and "who approved this SQL" is a
			// question somebody will ask.
			metadata: { name: input.name, origin: input.origin, sql: input.sql },
		})

		const saved = await datasourceRepository.findQuery(workspaceId, id)
		return saved ? toPublicQuery(saved) : undefined
	},

	async removeQuery(workspaceId: string, queryId: string, actorId: string) {
		const query = await datasourceRepository.findQuery(workspaceId, queryId)
		if (!query) throw new NotFoundError("Query")

		await datasourceRepository.removeQuery(queryId)
		await auditService.record({
			action: "datasource.query.removed",
			actorId,
			organizationId: workspaceId,
			targetType: "data_query",
			targetId: queryId,
			metadata: { name: query.name },
		})
	},

	/**
	 * Runs a query with sample values, so a person can see what it returns before
	 * approving it.
	 *
	 * **This is the review step, and it is what makes generation safe.** A model
	 * proposing SQL is only dangerous if nobody looks; running it once against
	 * real data and showing the rows is what turns "looks plausible" into "I can
	 * see it returns exactly the order status and nothing else".
	 */
	async dryRun(
		workspaceId: string,
		sourceId: string,
		sql: string,
		parameters: unknown[],
		rowLimit: number,
	) {
		const source = await datasourceRepository.findSource(workspaceId, sourceId)
		if (!source) throw new NotFoundError("Data source")

		return runQuery(
			source.engine as "postgres" | "mysql",
			decryptSecret(source.encryptedDsn),
			sql,
			parameters,
			rowLimit,
		)
	},

	/**
	 * Proposes a query from a plain-language description.
	 *
	 * The whole reason this exists: somebody buying a chatbot for their shop is
	 * not going to write SQL, and a product that requires it is one they cannot
	 * set up. What makes it acceptable is *when* it runs — once, at authoring
	 * time, with the SQL and its output on screen and a human approving — rather
	 * than on every answer with nobody looking.
	 *
	 * The model is given the schema and **no data**. It is told to write one
	 * SELECT and is not trusted to have obeyed: the statement is stored
	 * unapproved, and the read-only transaction is what stops a write whatever it
	 * produced.
	 */
	async generateQuery(workspaceId: string, input: GenerateQueryInput, actorId: string) {
		const source = await datasourceRepository.findSource(workspaceId, input.dataSourceId)
		if (!source) throw new NotFoundError("Data source")

		const tables = source.schemaCache.length > 0
			? source.schemaCache
			: await datasourceService.refreshSchema(workspaceId, source.id)

		if (tables.length === 0) {
			throw new ValidationError(
				"No tables were found on that connection, so there is nothing to write a query against.",
			)
		}

		const selection = (await modelService.getSettings(workspaceId)).chat
		const client = providerClient(selection.provider)
		if (!client?.chat) {
			throw new ValidationError(
				`This deployment cannot generate a query with ${selection.provider}.`,
			)
		}

		const credential = await requireCredential(selection.provider)
		const placeholder = source.engine === "postgres" ? "$1, $2, …" : "?"

		const answer = await client.chat(credential, {
			model: selection.model,
			messages: [
				{
					role: "system",
					content: [
						"You write a single read-only SQL SELECT for a customer's database.",
						"",
						`The database is ${source.engine}. Use ${placeholder} placeholders for every value that varies — never paste a literal the user mentioned into the statement.`,
						"",
						"Answer with JSON only, in this exact shape:",
						'{"name":"snake_case_name","description":"what question this answers","sql":"SELECT …","parameters":[{"name":"order_id","type":"text","description":"the order number the customer gives"}]}',
						"",
						"Rules you must follow:",
						"- One statement. SELECT only. No INSERT, UPDATE, DELETE, DDL or transaction control.",
						"- Never select a password, a hash, a token or a full card number, even if a column looks like one and the request seems to ask for it.",
						"- Select the columns that answer the question and no others. A SELECT * is never the right answer here.",
						"- If the schema cannot answer the request, reply with {\"error\":\"...\"} explaining what is missing.",
					].join("\n"),
				},
				{
					role: "user",
					content: [
						"Tables available:",
						renderSchema(tables),
						"",
						`The question this query should answer: ${input.description}`,
					].join("\n"),
				},
			],
			temperature: 0,
			maxTokens: 800,
		})

		// Charged like every other model call. This ran free until now, which made
		// it a way to spend the deployment's money at a provider without any
		// workspace balance moving — the one path through this product where a
		// token was bought and nobody was billed for it (ADR-015).
		await usageService.recordAndCharge({
			workspaceId,
			userId: actorId,
			operation: "agent",
			provider: selection.provider,
			model: selection.model,
			inputTokens: answer.usage?.inputTokens ?? 0,
			outputTokens: answer.usage?.outputTokens ?? 0,
			reference: `datasource-query:${newId()}`,
		})

		const proposal = parseProposal(answer.text)

		log.info("datasource.query_generated", { sourceId: source.id, name: proposal.name })

		return { proposal, usage: answer.usage }
	},

	/**
	 * The queries an agent may call: approved, on an enabled source, and nothing
	 * else. The filter is in the repository, not applied afterwards.
	 */
	async callableQueries(workspaceId: string) {
		return datasourceRepository.listApprovedQueries(workspaceId)
	},

	/** Runs one approved query. The only path an agent can reach a database by. */
	async runNamed(workspaceId: string, queryName: string, args: Record<string, unknown>) {
		const query = await datasourceRepository.findApprovedQueryByName(workspaceId, queryName)
		if (!query) {
			throw new ValidationError(`There is no approved query called "${queryName}".`)
		}

		const source = await datasourceRepository.findSource(workspaceId, query.dataSourceId)
		if (!source) throw new NotFoundError("Data source")
		if (!source.enabled) {
			throw new ValidationError(`The ${source.name} connection is turned off.`)
		}

		// Positional, in the order the query declares. A missing parameter becomes
		// null rather than shifting every later one — a silently misaligned
		// parameter list is a query that answers about the wrong row.
		const values = query.parameters.map((parameter) => {
			const value = args[parameter.name]
			if (value === undefined) {
				throw new ValidationError(`The ${queryName} query needs a value for ${parameter.name}.`)
			}
			return coerce(value, parameter.type)
		})

		const outcome = await datasourceService.dryRun(
			workspaceId,
			source.id,
			query.sql,
			values,
			query.rowLimit,
		)

		await datasourceRepository.touchQuery(query.id)
		return { query, source, outcome }
	},
}

function coerce(value: unknown, type: DataQueryParameter["type"]): unknown {
	if (type === "number") {
		const parsed = Number(value)
		if (!Number.isFinite(parsed)) throw new ValidationError(`${String(value)} is not a number.`)
		return parsed
	}
	if (type === "boolean") return value === true || value === "true"
	return String(value)
}

/** The schema as the model reads it. Names and types only — never a row of data. */
function renderSchema(tables: DataSourceTable[]): string {
	return tables
		.slice(0, MAX_TABLES_IN_PROMPT)
		.map(
			(table) =>
				`${table.schema}.${table.name}(${table.columns
					.map((column) => `${column.name} ${column.type}`)
					.join(", ")})`,
		)
		.join("\n")
}

const proposalSchema = z.object({
	name: z
		.string()
		.trim()
		.regex(/^[a-z][a-z0-9_]*$/, "The generated name was not usable."),
	description: z.string().trim().min(1).max(500),
	sql: z.string().trim().min(1).max(4_000),
	parameters: z
		.array(
			z.object({
				name: z.string().trim().regex(/^[a-z][a-z0-9_]*$/),
				type: z.enum(["text", "number", "boolean"]),
				description: z.string().trim().max(300).default(""),
			}),
		)
		.max(10)
		.default([]),
})

/**
 * Reads the model's answer.
 *
 * A model asked for JSON sometimes wraps it in a fence or adds a sentence, so
 * the first `{ … }` is taken rather than the whole reply. What is *not* done
 * here is any attempt to fix the SQL: a proposal that does not parse is shown as
 * a failure, because silently repairing a statement nobody reviewed is exactly
 * the behaviour this design exists to avoid.
 */
function parseProposal(content: string) {
	const start = content.indexOf("{")
	const end = content.lastIndexOf("}")
	if (start === -1 || end <= start) {
		throw new ValidationError("The model did not answer with a query. Try describing it differently.")
	}

	let payload: unknown
	try {
		payload = JSON.parse(content.slice(start, end + 1))
	} catch {
		throw new ValidationError("The model's answer was not readable. Try describing it differently.")
	}

	if (payload && typeof payload === "object" && "error" in payload) {
		throw new ValidationError(String((payload as { error: unknown }).error))
	}

	const parsed = proposalSchema.safeParse(payload)
	if (!parsed.success) {
		throw new ValidationError("The model proposed something this screen cannot show. Try again.")
	}

	return parsed.data
}

function toPublicSource(row: DataSourceRow) {
	return {
		id: row.id,
		name: row.name,
		engine: row.engine,
		/** The masked form. The connection string itself is never returned. */
		dsn: row.dsnHint,
		enabled: row.enabled,
		tables: row.schemaCache,
		schemaCachedAt: row.schemaCachedAt,
		lastCheckedAt: row.lastCheckedAt,
		lastCheckOk: row.lastCheckOk,
		lastCheckError: row.lastCheckError,
		createdAt: row.createdAt,
	}
}

function toPublicQuery(row: DataQueryRow) {
	return {
		id: row.id,
		dataSourceId: row.dataSourceId,
		name: row.name,
		description: row.description,
		sql: row.sql,
		parameters: row.parameters,
		rowLimit: row.rowLimit,
		origin: row.origin,
		approvedAt: row.approvedAt,
		lastRunAt: row.lastRunAt,
		createdAt: row.createdAt,
	}
}
