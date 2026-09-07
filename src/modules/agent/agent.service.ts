import { chatCapableClient } from "../../ai/clients"
import { resolveRerankModel } from "../../ai/rerank"
import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import type { PaginationQuery } from "../../shared/pagination"
import { page } from "../../shared/pagination"
import { auditService } from "../audit/audit.service"
import { knowledgeService } from "../knowledge/knowledge.service"
import { modelService } from "../model/model.service"
import { enqueueAgentRun } from "../../queue/agent.jobs"
import { agentRepository } from "./agent.repository"
import { RETRYABLE_STATUSES, nextSeq, readCheckpoint } from "./checkpoint"
import { validateGraph } from "./graph/types"
import { TOOL_CATALOGUE, TOOL_IDS, isToolId } from "./tools"
import type {
	AgentConfigInput,
	CreateAgentInput,
	RunAgentInput,
	UpdateAgentInput,
} from "./agent.dto"
import { clearStop, requestStop } from "./stop-signal"

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

	const unknown = config.tools.filter((id) => !isToolId(id))
	if (unknown.length > 0) {
		throw new ValidationError(
			`This deployment has no tool called ${unknown.map((id) => `"${id}"`).join(", ")}.`,
		)
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

	async list(workspaceId: string, query: PaginationQuery) {
		const { items, total } = await agentRepository.list(workspaceId, query)
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
				await agentRepository.insertVersion(version, tx)
				return row
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

		return { ...created, config: version }
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
		actorId: string,
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
			trigger: "manual",
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
