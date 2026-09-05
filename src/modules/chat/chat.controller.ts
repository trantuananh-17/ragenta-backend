import { streamSSE } from "hono/streaming"

import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import { isAppError } from "../../shared/errors"
import { paginationQuerySchema } from "../../shared/pagination"
import {
	createConversationSchema,
	sendMessageSchema,
	updateConversationSchema,
} from "./chat.dto"
import { chatService } from "./chat.service"

export const chatController = {
	async listConversations(c: AppContext) {
		const membership = requireMembership(c)
		const query = paginationQuerySchema.parse(c.req.query())
		return c.json(await chatService.listConversations(membership.organizationId, query))
	},

	async createConversation(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = createConversationSchema.parse(await c.req.json())
		return c.json(
			await chatService.createConversation(membership.organizationId, input, user.id),
			201,
		)
	},

	async getConversation(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(
			await chatService.getConversation(
				membership.organizationId,
				requireParam(c, "conversationId"),
			),
		)
	},

	async updateConversation(c: AppContext) {
		const membership = requireMembership(c)
		const input = updateConversationSchema.parse(await c.req.json())
		return c.json(
			await chatService.updateConversation(
				membership.organizationId,
				requireParam(c, "conversationId"),
				input,
			),
		)
	},

	async deleteConversation(c: AppContext) {
		const membership = requireMembership(c)
		await chatService.deleteConversation(
			membership.organizationId,
			requireParam(c, "conversationId"),
		)
		return c.body(null, 204)
	},

	async listMessages(c: AppContext) {
		const membership = requireMembership(c)
		const query = paginationQuerySchema.parse(c.req.query())
		return c.json(
			await chatService.listMessages(
				membership.organizationId,
				requireParam(c, "conversationId"),
				query,
			),
		)
	},

	/**
	 * Server-Sent Events, not WebSocket. The stream is one-directional and lives
	 * for one turn, which is exactly what SSE is; a WebSocket would add a second
	 * protocol for the reverse proxy to get right for no capability gained.
	 *
	 * Everything that can refuse the turn runs before the stream opens, so a
	 * refusal is a normal 4xx the client can act on rather than an error frame
	 * arriving after the UI has already switched into "answering".
	 */
	async streamMessage(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = sendMessageSchema.parse(await c.req.json())

		const turn = await chatService.prepareTurn(
			membership.organizationId,
			requireParam(c, "conversationId"),
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
				for await (const event of chatService.streamTurn(
					membership.organizationId,
					turn,
					controller.signal,
				)) {
					await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
				}
			} catch (error) {
				const message = isAppError(error)
					? error.message
					: "The answer could not be completed."
				await stream.writeSSE({
					event: "error",
					data: JSON.stringify({ type: "error", message }),
				})
			}
		})
	},

	async sendMessage(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = sendMessageSchema.parse(await c.req.json())

		const turn = await chatService.prepareTurn(
			membership.organizationId,
			requireParam(c, "conversationId"),
			input,
			user.id,
		)

		return c.json(await chatService.completeTurn(membership.organizationId, turn), 201)
	},
}
