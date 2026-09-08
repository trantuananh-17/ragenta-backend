import { memoryService } from "../../memory/memory.service"
import {
	memorySearchParameters,
	memoryWriteParameters,
	renderRecall,
} from "./memory-content"
import type { AgentTool, ToolContext, ToolResult } from "./types"

/**
 * The two memory tools.
 *
 * Both are closed over the **agent** and the **scope the version was published
 * with**, exactly as `knowledge_search` is closed over its bases: the model
 * chooses what to remember, never whose memory to read or write. Letting it name
 * a user id would be the same class of hole as letting it name a knowledge base
 * it was not given (`.claude/rules/security.md`).
 *
 * `aboutThisPerson` is the one thing the model does decide, and it can only
 * narrow: on an agent-scoped version it is ignored, because there is no person
 * in scope to attach a memory to.
 */
export function createMemoryTools(config: {
	agentId: string
	scope: "agent" | "user"
	topK: number
}): AgentTool[] {
	function scopeFor(context: ToolContext, personal: boolean) {
		return {
			workspaceId: context.workspaceId,
			agentId: config.agentId,
			userId: config.scope === "user" && personal ? context.userId : null,
		}
	}

	return [
		{
			name: "memory_write",
			description:
				"Remember one fact for future conversations. Use it for things that will still matter next time — a preference, a decision, a name for something. Do not use it for what is already in the documents you can search, and do not record anything the person would not expect you to keep.",
			parameters: memoryWriteParameters,

			async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
				const input = memoryWriteParameters.parse(args)
				const personal = input.aboutThisPerson === true

				// A version scoped to the agent has no person to attach a memory to,
				// and a run started by a schedule has no user at all. Saying so beats
				// writing it to the shared scope, which would leak one person's detail
				// into everybody's recall.
				if (personal && (config.scope !== "user" || context.userId === null)) {
					return {
						ok: false,
						content:
							"This agent does not keep memories about individual people, so that fact was not saved. Save it as a fact about the work, or do not save it.",
					}
				}

				const written = await memoryService.remember(
					scopeFor(context, personal),
					input.content,
					"tool",
				)

				if (!written) {
					return { ok: false, content: "There was nothing to remember in that." }
				}

				return {
					ok: true,
					content: "Noted.",
					metadata: { memoryId: written.id, personal },
				}
			},
		},

		{
			name: "memory_search",
			description:
				"Look through what you have remembered from earlier conversations. The most relevant notes are already in your context at the start of a run — use this when you need something older or more specific.",
			parameters: memorySearchParameters,

			async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
				const input = memorySearchParameters.parse(args)

				const found = await memoryService.recall(
					scopeFor(context, true),
					input.query,
					config.topK,
				)

				return {
					ok: true,
					content: renderRecall(input.query, found),
					metadata: { query: input.query, results: found.length },
				}
			},
		},
	]
}
