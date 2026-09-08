import { chatCapableClient } from "../../ai/clients"
import { resolveRerankModel } from "../../ai/rerank"
import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { agent } from "../../db/schema"
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import type { PaginationQuery } from "../../shared/pagination"
import { page } from "../../shared/pagination"
import { auditService } from "../audit/audit.service"
import { knowledgeService } from "../knowledge/knowledge.service"
import { modelService } from "../model/model.service"
import { enqueueAgentRun } from "../../queue/agent.jobs"
import { visibilityFor } from "../rbac/visibility"
import type { MembershipRow } from "../workspace/workspace.repository"
import { agentRepository } from "./agent.repository"
import { RETRYABLE_STATUSES, nextSeq, readCheckpoint } from "./checkpoint"
import { validateGraph } from "./graph/types"
import { isMcpToolId, mcpService } from "../mcp/mcp.service"
import { integrationService } from "../integration/integration.service"
import { agentConfigSchema } from "./agent.dto"
import { AGENT_TEMPLATES, findTemplate } from "./templates"
import { TOOL_CATALOGUE, TOOL_IDS, isToolId } from "./tools"
import type { ToolId } from "./tools"
import type { AgentConfigInput, CreateAgentInput, CreateFromTemplateInput, RunAgentInput, UpdateAgentInput } from "./agent.dto"
import { clearStop, requestStop } from "./stop-signal"
import { diffVersions } from "./version-diff"

/**
 * Turns a validated configuration into the columns of a new immutable version.
 *
 * The checks run first and outside the transaction on purpose: they are provider
 * and knowledge-base lookups, and holding a transaction open across them would
 * keep a row locked for the length of a network call.
 */
async function versionValues(
	workspaceId: string,
	agentId: string,
	version: number,
	config: AgentConfigInput,
	actorId: string,
	projectId: string | null,
) {
	await knowledgeService.assertBasesSearchableTogether(workspaceId, config.knowledgeBaseIds)
	if (config.model) {
		await modelService.assertSelectable(workspaceId, config.model, "chat")
	}
	if (config.rerank) {
		await resolveRerankModel(config.rerank.provider, config.rerank.model)
	}

	const unknown = config.tools.filter((id) => !isToolId(id) && !isMcpToolId(id))
	if (unknown.length > 0) {
		throw new ValidationError(
			`This deployment has no tool called ${unknown.map((id) => `"${id}"`).join(", ")}.`,
		)
	}

	// An MCP tool is checked against the servers this workspace can actually
	// reach, at publish time. A version naming a server nobody configured would
	// otherwise publish cleanly and lose a tool at run time, where the reason is
	// a log line rather than a message on the screen somebody is looking at.
	for (const id of config.tools.filter(isMcpToolId)) {
		await mcpService.assertToolAvailable(workspaceId, id)
	}

	if (config.tools.includes("knowledge_search") && config.knowledgeBaseIds.length === 0) {
		throw new ValidationError(
			"An agent given the knowledge search tool needs at least one knowledge base to search.",
		)
	}

	if (config.graph) {
		const problems = validateGraph(config.graph)
		if (problems.length > 0) {
			throw new ValidationError(`This flow cannot be published. ${problems.join(" ")}`)
		}
	}

	/**
	 * A tool-using agent is refused at publish time on a provider that cannot call
	 * tools, rather than at run time. The failure is otherwise invisible: the model
	 * answers in prose, never calls anything, and looks merely unhelpful.
	 *
	 * A flow's nodes call tools even when the version's own tool list is empty, so
	 * the check covers both.
	 */
	if (config.tools.length > 0 || config.graph) {
		const selection =
			config.model ?? (await modelService.resolveChatModel(workspaceId, projectId ?? undefined))
		const client = chatCapableClient(selection.provider)
		if (!client?.supportsTools) {
			throw new ValidationError(
				`The ${selection.provider} provider cannot call tools. Choose a different model for this agent, or remove its tools.`,
			)
		}
	}

	return {
		id: newId(),
		agentId,
		version,
		instructions: config.instructions,
		provider: config.model?.provider ?? null,
		model: config.model?.model ?? null,
		temperature: config.temperature?.toFixed(2) ?? null,
		maxOutputTokens: config.maxOutputTokens,
		knowledgeBaseIds: config.knowledgeBaseIds,
		searchMode: config.searchMode,
		topK: config.topK,
		similarityThreshold: config.similarityThreshold?.toFixed(3) ?? null,
		vectorWeight: config.vectorWeight?.toFixed(3) ?? null,
		rerankProvider: config.rerank?.provider ?? null,
		rerankModel: config.rerank?.model ?? null,
		groundedOnly: config.groundedOnly,
		graph: config.graph,
		tools: config.tools,
		maxRounds: config.maxRounds,
		creditCeiling: config.creditCeiling?.toFixed(4) ?? null,
		memoryEnabled: config.memoryEnabled,
		memoryScope: config.memoryScope,
		memoryTopK: config.memoryTopK,
		createdBy: actorId,
	}
}

export const agentService = {
	/**
	 * The tools this deployment can run, for the screen that offers them. Read
	 * from the registry rather than restated, so a tool added to the code appears
	 * here without a second edit.
	 */
	tools() {
		return TOOL_IDS.map((id) => ({ id, ...TOOL_CATALOGUE[id] }))
	},

	/**
	 * The templates somebody can start an agent from, with each one's tools marked
	 * available or not on *this* deployment.
	 *
	 * A template asking for `web_search` on a deployment with no search connection
	 * is not an error — it is a template that will produce a slightly smaller
	 * agent, and the screen should say which part it cannot have rather than
	 * offering something that fails on its first run (ADR-057).
	 */
	async listTemplates(workspaceId: string) {
		const connections = await integrationService.list(workspaceId)
		const usable = new Set(
			connections.filter((row) => row.enabled).map((row) => row.name),
		)

		return AGENT_TEMPLATES.map((template) => ({
			...template,
			tools: template.tools.map((id) => {
				const required = TOOL_CATALOGUE[id].requires
				return {
					id,
					title: TOOL_CATALOGUE[id].title,
					available: required === null || usable.has(required),
					requires: required,
				}
			}),
		}))
	},

	/**
	 * Creates an agent from a template.
	 *
	 * Tools the deployment cannot run are **dropped and reported**, not refused:
	 * a support agent without web search is still a support agent, and an error
	 * telling somebody to go and configure Tavily before they can try anything is
	 * a worse first five minutes. What is refused is a template that needs a
	 * knowledge base with none given, because that one produces an agent whose
	 * every answer is "I could not find anything".
	 */
	async createFromTemplate(
		workspaceId: string,
		input: CreateFromTemplateInput,
		actorId: string,
	) {
		const template = findTemplate(input.templateId)
		if (!template) throw new NotFoundError("Template")

		if (template.needsKnowledgeBase && input.knowledgeBaseIds.length === 0) {
			throw new ValidationError(
				`${template.name} answers from documents, so it needs at least one knowledge base.`,
			)
		}

		const connections = await integrationService.list(workspaceId)
		const usable = new Set(connections.filter((row) => row.enabled).map((row) => row.name))

		const kept: ToolId[] = []
		const dropped: string[] = []
		for (const id of template.tools) {
			const required = TOOL_CATALOGUE[id].requires
			if (required === null || usable.has(required)) kept.push(id)
			else dropped.push(id)
		}

		// A template that asks for the search tool and is given no base would be
		// refused at publish time; drop it rather than fail, for the same reason
		// the connection-backed tools are dropped.
		const tools =
			input.knowledgeBaseIds.length === 0
				? kept.filter((id) => id !== "knowledge_search")
				: kept

		const agent = await agentService.create(
			workspaceId,
			{
				name: input.name ?? template.name,
				description: template.summary,
				projectId: input.projectId,
				config: agentConfigSchema.parse({
					instructions: template.instructions,
					knowledgeBaseIds: input.knowledgeBaseIds,
					tools,
					maxRounds: template.maxRounds,
					groundedOnly: template.groundedOnly,
					memoryEnabled: template.memory.enabled,
					memoryScope: template.memory.scope,
				}),
			},
			actorId,
		)

		return { agent, droppedTools: dropped, template: template.id }
	},

	/** Narrowed to the agents this caller may read, page and total together (ADR-054). */
	async list(membership: MembershipRow, query: PaginationQuery) {
		const visible = await visibilityFor(membership, "agent", "agent.read")
		const { items, total } = await agentRepository.list(
			membership.organizationId,
			query,
			visible.unrestricted ? undefined : visible.condition(agent.id),
		)
		return page(items, total, query)
	},

	async get(workspaceId: string, agentId: string) {
		const row = await agentRepository.findById(workspaceId, agentId)
		if (!row) throw new NotFoundError("Agent")
		const version = await agentRepository.findVersion(row.id, row.currentVersion)
		return { ...row, config: version ?? null }
	},

	/**
	 * Creating an agent writes version 1 in the same transaction, so an agent with
	 * nothing to run is not a state that exists (ADR-029).
	 */
	async create(workspaceId: string, input: CreateAgentInput, actorId: string) {
		const agentId = newId()
		const version = await versionValues(
			workspaceId,
			agentId,
			1,
			input.config,
			actorId,
			input.projectId,
		)

		const created = await db
			.transaction(async (tx: DbExecutor) => {
				const row = await agentRepository.insert(
					{
						id: agentId,
						organizationId: workspaceId,
						projectId: input.projectId,
						name: input.name,
						description: input.description,
						status: "draft",
						currentVersion: 1,
						createdBy: actorId,
					},
					tx,
				)
				const stored = await agentRepository.insertVersion(version, tx)
				// The stored row, not the values that were sent: `createdAt` is a
				// column default, so the object handed to the insert does not carry
				// one and a response built from it is missing a field the client
				// requires.
				return { ...row, config: stored }
			})
			.catch((error: unknown) => {
				// The unique index on (organization_id, name) is what enforces this;
				// a read-then-write check would still race two concurrent creates.
				if (String(error).includes("agent_organizationId_name_uidx")) {
					throw new ConflictError(`An agent called "${input.name}" already exists.`)
				}
				throw error
			})

		await auditService.record({
			action: "agent.created",
			actorId,
			organizationId: workspaceId,
			targetType: "agent",
			targetId: agentId,
			metadata: { name: input.name },
		})

		return created
	},

	async update(
		workspaceId: string,
		agentId: string,
		input: UpdateAgentInput,
		actorId: string,
	) {
		const existing = await agentRepository.findById(workspaceId, agentId)
		if (!existing) throw new NotFoundError("Agent")

		const updated = await agentRepository.update(workspaceId, agentId, {
			...(input.name === undefined ? {} : { name: input.name }),
			...(input.description === undefined ? {} : { description: input.description }),
			...(input.projectId === undefined ? {} : { projectId: input.projectId }),
			...(input.status === undefined ? {} : { status: input.status }),
		})

		if (input.status && input.status !== existing.status) {
			await auditService.record({
				action: "agent.status_changed",
				actorId,
				organizationId: workspaceId,
				targetType: "agent",
				targetId: agentId,
				metadata: { from: existing.status, to: input.status },
			})
		}

		return updated
	},

	/**
	 * Publishes a new immutable version and makes it current.
	 *
	 * Runs already in flight keep the version they named — they hold its id, not
	 * the agent's pointer — which is the whole reason the configuration is
	 * versioned rather than edited in place.
	 */
	async publishVersion(
		workspaceId: string,
		agentId: string,
		config: AgentConfigInput,
		actorId: string,
	) {
		const existing = await agentRepository.findById(workspaceId, agentId)
		if (!existing) throw new NotFoundError("Agent")

		const created = await db.transaction(async (tx: DbExecutor) => {
			const next = await agentRepository.nextVersion(agentId, tx)
			const values = await versionValues(
				workspaceId,
				agentId,
				next,
				config,
				actorId,
				existing.projectId,
			)
			const version = await agentRepository.insertVersion(values, tx)
			await agentRepository.update(workspaceId, agentId, { currentVersion: next }, tx)
			return version
		})

		await auditService.record({
			action: "agent.version_published",
			actorId,
			organizationId: workspaceId,
			targetType: "agent",
			targetId: agentId,
			metadata: { version: created?.version },
		})

		return created
	},

	async listVersions(workspaceId: string, agentId: string) {
		const existing = await agentRepository.findById(workspaceId, agentId)
		if (!existing) throw new NotFoundError("Agent")
		return agentRepository.listVersions(agentId)
	},

	/**
	 * What changed between two versions.
	 *
	 * The history has been immutable since ADR-029 and unreadable ever since —
	 * "version 7 started hallucinating" is unanswerable when the only thing on
	 * screen is a list of numbers, and the answer is nearly always one field
	 * somebody changed without thinking of it as a change.
	 */
	async diffVersions(workspaceId: string, agentId: string, from: number, to: number) {
		const existing = await agentRepository.findById(workspaceId, agentId)
		if (!existing) throw new NotFoundError("Agent")

		const [before, after] = await Promise.all([
			agentRepository.findVersion(agentId, from),
			agentRepository.findVersion(agentId, to),
		])
		if (!before || !after) throw new NotFoundError("Agent version")

		return {
			from: { version: before.version, createdAt: before.createdAt },
			to: { version: after.version, createdAt: after.createdAt },
			changes: diffVersions(
				before as unknown as Record<string, unknown>,
				after as unknown as Record<string, unknown>,
			),
		}
	},

	/**
	 * Goes back to an earlier version by **publishing it again**, not by moving a
	 * pointer.
	 *
	 * A rollback that repointed `currentVersion` at version 3 would make the run
	 * history ambiguous — two stretches of runs recorded against one version row,
	 * with nothing to say which stretch a given run belonged to. Publishing a copy
	 * keeps the invariant the whole feature rests on: a version is written once,
	 * and the numbers only ever go up.
	 */
	async restoreVersion(
		workspaceId: string,
		agentId: string,
		version: number,
		actorId: string,
	) {
		const existing = await agentRepository.findById(workspaceId, agentId)
		if (!existing) throw new NotFoundError("Agent")
		if (version === existing.currentVersion) {
			throw new ValidationError("That version is already the current one.")
		}

		const source = await agentRepository.findVersion(agentId, version)
		if (!source) throw new NotFoundError("Agent version")

		const created = await agentService.publishVersion(
			workspaceId,
			agentId,
			agentConfigSchema.parse({
				instructions: source.instructions,
				model:
					source.provider && source.model
						? { provider: source.provider, model: source.model }
						: null,
				temperature: source.temperature === null ? null : Number(source.temperature),
				maxOutputTokens: source.maxOutputTokens,
				knowledgeBaseIds: source.knowledgeBaseIds,
				searchMode: source.searchMode,
				topK: source.topK,
				similarityThreshold:
					source.similarityThreshold === null ? null : Number(source.similarityThreshold),
				vectorWeight: source.vectorWeight === null ? null : Number(source.vectorWeight),
				rerank:
					source.rerankProvider && source.rerankModel
						? { provider: source.rerankProvider, model: source.rerankModel }
						: null,
				groundedOnly: source.groundedOnly,
				tools: source.tools,
				maxRounds: source.maxRounds,
				creditCeiling: source.creditCeiling === null ? null : Number(source.creditCeiling),
				graph: source.graph,
				approveWrites: source.approveWrites,
				memoryEnabled: source.memoryEnabled,
				memoryScope: source.memoryScope,
				memoryTopK: source.memoryTopK,
			}),
			actorId,
		)

		await auditService.record({
			action: "agent.version_restored",
			actorId,
			organizationId: workspaceId,
			targetType: "agent",
			targetId: agentId,
			metadata: { restored: version, publishedAs: created?.version },
		})

		return { version: created, restoredFrom: version }
	},

	async remove(workspaceId: string, agentId: string, actorId: string) {
		const existing = await agentRepository.findById(workspaceId, agentId)
		if (!existing) throw new NotFoundError("Agent")

		await agentRepository.remove(workspaceId, agentId)
		await auditService.record({
			action: "agent.deleted",
			actorId,
			organizationId: workspaceId,
			targetType: "agent",
			targetId: agentId,
			metadata: { name: existing.name },
		})
	},

	async listRuns(workspaceId: string, agentId: string, query: PaginationQuery) {
		const existing = await agentRepository.findById(workspaceId, agentId)
		if (!existing) throw new NotFoundError("Agent")
		const { items, total } = await agentRepository.listRuns(workspaceId, agentId, query)
		return page(items, total, query)
	},

	async getRun(workspaceId: string, runId: string) {
		const run = await agentRepository.findRun(workspaceId, runId)
		if (!run) throw new NotFoundError("Agent run")
		return run
	},

	async listSteps(workspaceId: string, runId: string) {
		await this.getRun(workspaceId, runId)
		return agentRepository.listSteps(runId)
	},

	/**
	 * Queues a run for the worker instead of streaming it in the request.
	 *
	 * The run row is written here, so the caller gets an id it can poll and stop
	 * before any worker has looked at it. Everything else a run needs is read off
	 * that row when the job runs — the payload carries ids only, because a job
	 * queued before a deploy has to act on what is true afterwards.
	 */
	async queueRun(
		workspaceId: string,
		agentId: string,
		input: RunAgentInput,
		actorId: string | null,
		/**
		 * Who asked. A trigger fires with no person behind it, and recording that
		 * honestly is what lets a run list say "this one ran itself" — attributing
		 * it to whoever created the trigger would put somebody's name on a run they
		 * were asleep for.
		 */
		trigger: "manual" | "api" | "schedule" | "webhook" = "manual",
	) {
		const agent = await agentRepository.findById(workspaceId, agentId)
		if (!agent) throw new NotFoundError("Agent")
		if (agent.status !== "active") {
			throw new ValidationError(`This agent is ${agent.status}. Activate it before running it.`)
		}

		const version = await agentRepository.findVersion(agent.id, agent.currentVersion)
		if (!version) throw new NotFoundError("Agent version")

		const run = await agentRepository.insertRun({
			id: newId(),
			organizationId: workspaceId,
			agentId: agent.id,
			agentVersionId: version.id,
			projectId: agent.projectId,
			userId: actorId,
			trigger,
			status: "pending",
			input: { input: input.input, documentIds: input.documentIds ?? [] },
		})
		if (!run) throw new ValidationError("The run could not be queued.")

		await enqueueAgentRun({ workspaceId, runId: run.id }, run.attempts)

		return { runId: run.id, status: run.status, attempts: run.attempts }
	},

	/**
	 * Runs a failed or stopped run again, from its last checkpoint rather than
	 * from the beginning.
	 *
	 * On the queue rather than over SSE: the attempt this one is replacing died,
	 * which is the case where holding an HTTP request open is exactly the wrong
	 * thing to do. A run waiting on a person is not retried — answering it is a
	 * decision, and `resume` is where that happens.
	 */
	async retryRun(workspaceId: string, runId: string) {
		const run = await this.getRun(workspaceId, runId)
		if (!(RETRYABLE_STATUSES as readonly string[]).includes(run.status)) {
			throw new ValidationError(
				`Only a failed or stopped run can be retried. This one is ${run.status}.`,
			)
		}

		// A run that was stopped still carries the flag that stopped it, and the
		// next attempt polls the same key — leaving it would have the retry stop
		// at its first node.
		await clearStop(workspaceId, runId)
		await agentRepository.updateRun(runId, { status: "pending", error: null, finishedAt: null })
		await enqueueAgentRun({ workspaceId, runId }, run.attempts)

		return {
			runId: run.id,
			status: "pending",
			attempt: run.attempts + 1,
			/** Where the next attempt starts numbering, and so what it will not re-bill. */
			resumingFromStep: nextSeq(readCheckpoint(run.state)),
		}
	},

	/**
	 * Asks a run to stop — the cancellation route as well as the stop button,
	 * because they are one thing: an ask that the run ends at its next boundary
	 * and keeps what it has (ADR-028).
	 *
	 * The run row is read first, which is what proves the caller's workspace owns
	 * it — the flag itself carries no authority.
	 */
	async stopRun(workspaceId: string, runId: string) {
		const run = await this.getRun(workspaceId, runId)
		await requestStop(workspaceId, runId)

		// A queued run has no loop polling the flag yet, so nothing would ever act
		// on it and the run would sit as pending until a worker picked it up and
		// stopped it. Closing it here is what makes cancelling a queued run
		// immediate; the flag still stands, so a worker that claimed it in the
		// meantime stops at its next node and writes the same outcome.
		if (run.status === "pending") {
			await agentRepository.updateRun(runId, { status: "stopped", finishedAt: new Date() })
			return { runId: run.id, requested: true, status: "stopped" }
		}

		return { runId: run.id, requested: true, status: run.status }
	},
}
