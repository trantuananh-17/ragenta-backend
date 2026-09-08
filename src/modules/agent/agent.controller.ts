import { streamSSE } from "hono/streaming"

import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import { isAppError } from "../../shared/errors"
import { paginationQuerySchema } from "../../shared/pagination"
import {
	agentConfigSchema,
	createAgentSchema,
	createFromTemplateSchema,
	resumeRunSchema,
	runAgentSchema,
	updateAgentSchema,
} from "./agent.dto"
import { agentService } from "./agent.service"
import { agentRunner } from "./runner"

export const agentController = {
	listTools(c: AppContext) {
		requireMembership(c)
		return c.json(agentService.tools())
	},

	async list(c: AppContext) {
		const membership = requireMembership(c)
		const query = paginationQuerySchema.parse(c.req.query())
		return c.json(await agentService.list(membership, query))
	},

	async create(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = createAgentSchema.parse(await c.req.json())
		return c.json(await agentService.create(membership.organizationId, input, user.id), 201)
	},

	async get(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(
			await agentService.get(membership.organizationId, requireParam(c, "agentId")),
		)
	},

	async update(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = updateAgentSchema.parse(await c.req.json())
		return c.json(
			await agentService.update(
				membership.organizationId,
				requireParam(c, "agentId"),
				input,
				user.id,
			),
		)
	},

	async remove(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		await agentService.remove(membership.organizationId, requireParam(c, "agentId"), user.id)
		return c.body(null, 204)
	},

	async listVersions(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(
			await agentService.listVersions(membership.organizationId, requireParam(c, "agentId")),
		)
	},

	async publishVersion(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const config = agentConfigSchema.parse(await c.req.json())
		return c.json(
			await agentService.publishVersion(
				membership.organizationId,
				requireParam(c, "agentId"),
				config,
				user.id,
			),
			201,
		)
	},

	async listRuns(c: AppContext) {
		const membership = requireMembership(c)
		const query = paginationQuerySchema.parse(c.req.query())
		return c.json(
			await agentService.listRuns(
				membership.organizationId,
				requireParam(c, "agentId"),
				query,
			),
		)
	},

	async getRun(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(await agentService.getRun(membership.organizationId, requireParam(c, "runId")))
	},

	async listSteps(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(
			await agentService.listSteps(membership.organizationId, requireParam(c, "runId")),
		)
	},

	async stopRun(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(
			await agentService.stopRun(membership.organizationId, requireParam(c, "runId")),
		)
	},

	/**
	 * Queue the run for the worker instead of streaming it. 202 and a run id: the
	 * client polls the run and its steps, which the runner writes as it goes.
	 */
	async queueRun(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = runAgentSchema.parse(await c.req.json())
		return c.json(
			await agentService.queueRun(
				membership.organizationId,
				requireParam(c, "agentId"),
				input,
				user.id,
			),
			202,
		)
	},

	async retryRun(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(
			await agentService.retryRun(membership.organizationId, requireParam(c, "runId")),
			202,
		)
	},

	/**
	 * Answer what a paused flow asked for, and carry on.
	 *
	 * The same SSE stream a run opens, on the same run row: it is one execution
	 * that happened to wait for a person in the middle, and two rows would split
	 * its credits and its steps between two things.
	 */
	async resumeRun(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = resumeRunSchema.parse(await c.req.json())

		const prepared = await agentRunner.resume(
			membership.organizationId,
			requireParam(c, "runId"),
			input.answers,
			user.id,
		)

		c.header("X-Accel-Buffering", "no")
		c.header("Cache-Control", "no-cache, no-transform")

		return streamSSE(c, async (stream) => {
			const controller = new AbortController()
			stream.onAbort(() => controller.abort())

			try {
				for await (const event of agentRunner.stream(
					membership.organizationId,
					prepared,
					controller.signal,
				)) {
					await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
				}
			} catch (error) {
				const message = isAppError(error) ? error.message : "The run could not be completed."
				await stream.writeSSE({
					event: "error",
					data: JSON.stringify({ type: "error", message }),
				})
			}
		})
	},

	/**
	 * Server-Sent Events, the same shape a chat turn streams over. Everything that
	 * can refuse the run runs in `prepare`, before the stream opens, so a refusal
	 * is a normal 4xx rather than an error frame arriving after the UI has already
	 * switched into "running".
	 */
	async run(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = runAgentSchema.parse(await c.req.json())

		const prepared = await agentRunner.prepare(
			membership.organizationId,
			requireParam(c, "agentId"),
			input,
			user.id,
		)

		// nginx buffers a proxied response by default, which holds every token
		// until the answer is complete and makes streaming pointless.
		c.header("X-Accel-Buffering", "no")
		c.header("Cache-Control", "no-cache, no-transform")

		return streamSSE(c, async (stream) => {
			// The provider call is aborted when the client goes away, so a closed
			// tab stops costing money instead of generating into nothing.
			const controller = new AbortController()
			stream.onAbort(() => controller.abort())

			try {
				for await (const event of agentRunner.stream(
					membership.organizationId,
					prepared,
					controller.signal,
				)) {
					await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
				}
			} catch (error) {
				const message = isAppError(error) ? error.message : "The run could not be completed."
				await stream.writeSSE({
					event: "error",
					data: JSON.stringify({ type: "error", message }),
				})
			}
		})
	},

	async listTemplates(c: AppContext) {
		const membership = requireMembership(c)
		return c.json({ templates: await agentService.listTemplates(membership.organizationId) })
	},

	async createFromTemplate(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = createFromTemplateSchema.parse(await c.req.json())
		const result = await agentService.createFromTemplate(
			membership.organizationId,
			input,
			user.id,
		)
		return c.json(result, 201)
	},
}
