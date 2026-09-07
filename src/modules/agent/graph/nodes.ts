import { z } from "zod"

import type { ChatCapableClient, ChatMessage, ProviderCredential } from "../../../ai/clients"
import { ValidationError } from "../../../shared/errors"
import { retrievalService } from "../../retrieval/retrieval.service"
import type { CitationCollector } from "../citations"
import { runToolLoop } from "../loop"
import { toolsFor } from "../tools"
import type { ToolId } from "../tools"
import {
	browserNodeParams,
	carriedValues,
	excelNodeParams,
	httpNodeParams,
	LOOP_SCOPE,
	loopNodeParams,
	ocrNodeParams,
	parseLoopItems,
	plannedIterations,
	sttNodeParams,
	ttsNodeParams,
	visionNodeParams,
} from "./node-params"
import type { NodeOutput } from "./types"
import type { GraphNode } from "./types"
import { resolveTemplate } from "./types"

/**
 * What every node is given, and the only way it reaches anything outside itself.
 *
 * `charge` and `record` are callbacks rather than services because the engine
 * owns the run's step numbering and its credit total — a node that wrote its own
 * `usage_ledger` row could not know which step it was.
 */
export interface NodeContext {
	workspaceId: string
	projectId: string | null
	userId: string | null
	runId: string
	client: ChatCapableClient
	credential: ProviderCredential
	selection: { provider: string; model: string }
	maxOutputTokens: number
	temperature?: number
	knowledgeBaseIds: string[]
	citations: CitationCollector
	/** Node outputs so far, for `{{node.field}}` references. */
	values: Record<string, Record<string, string>>
	signal?: AbortSignal
	charge(input: {
		kind: "model" | "retrieval" | "tool"
		nodeId: string
		name?: string
		provider: string
		model: string
		operation: "agent" | "rerank" | "embedding"
		inputTokens: number
		outputTokens: number
		estimated: boolean
		payload?: Record<string, unknown>
		output?: Record<string, unknown>
	}): Promise<void>
	record(input: {
		nodeId: string
		name: string
		ok: boolean
		payload: Record<string, unknown>
		output: Record<string, unknown>
	}): Promise<void>
	/**
	 * Runs one node as a loop's body, and the only way a `loop` node reaches it.
	 *
	 * Installed by the engine, like `values`, rather than passed in by the caller:
	 * `runner.ts` builds this context and has neither the graph nor the run's node
	 * budget, and both are needed to run a body node at all. Optional because a
	 * context built outside a graph has no engine to install it — a `loop` node
	 * given one refuses rather than half-working.
	 */
	runBody?(bodyNodeId: string): AsyncGenerator<NodeEvent, NodeOutput>
	/** What is left of the run-wide node budget. Also installed by the engine. */
	remainingExecutions?(): number
}

/** What a node emits while it runs. Deltas reach the browser as they happen. */
export type NodeEvent =
	| { type: "delta"; text: string }
	| { type: "tool_started"; name: string; arguments: string }
	| { type: "tool_finished"; name: string; ok: boolean; summary: string }
	| { type: "citations" }

export interface NodeImplementation {
	/** Yields events as it works and returns what the nodes after it can read. */
	execute(
		context: NodeContext,
		node: GraphNode,
		nodeId: string,
	): AsyncGenerator<NodeEvent, NodeOutput>
}

/** `{{sys.input}}` and every finished node, as one lookup for the templates. */
function scope(context: NodeContext): Record<string, Record<string, string>> {
	return context.values
}

// ---------------------------------------------------------------------------

const beginNode: NodeImplementation = {
	// eslint-disable-next-line require-yield
	async *execute(context): AsyncGenerator<NodeEvent, NodeOutput> {
		// The entry point produces the run's input so everything after it can
		// reference `{{begin.text}}` the same way it references any other node.
		return { text: context.values.sys?.input ?? "" }
	},
}

const llmParams = z.object({
	prompt: z.string().min(1),
	/** Prepended as a system message. Empty means the node has no persona. */
	system: z.string().default(""),
})

const llmNode: NodeImplementation = {
	async *execute(context, node, nodeId): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = llmParams.parse(node.params)
		const prompt = resolveTemplate(params.prompt, scope(context))
		const system = resolveTemplate(params.system, scope(context))

		const messages: ChatMessage[] = [
			...(system ? [{ role: "system" as const, content: system }] : []),
			{ role: "user" as const, content: prompt },
		]

		let text = ""
		for await (const event of runToolLoop(messages, {
			client: context.client,
			credential: context.credential,
			model: context.selection.model,
			temperature: context.temperature,
			maxTokens: context.maxOutputTokens,
			tools: [],
			maxRounds: 1,
			toolContext: {
				workspaceId: context.workspaceId,
				projectId: context.projectId,
				userId: context.userId,
				runId: context.runId,
				signal: context.signal,
			},
			signal: context.signal,
		})) {
			if (event.type === "delta") yield { type: "delta", text: event.text }
			else if (event.type === "round_finished") {
				await context.charge({
					kind: "model",
					nodeId,
					name: node.label || nodeId,
					provider: context.selection.provider,
					model: context.selection.model,
					operation: "agent",
					inputTokens: event.charge.inputTokens,
					outputTokens: event.charge.outputTokens,
					estimated: event.charge.estimated,
					output: { characters: event.charge.text.length },
				})
			} else if (event.type === "finished") text = event.text
		}

		return { text }
	},
}

const searchParams = z.object({
	query: z.string().min(1),
	topK: z.number().int().min(1).max(20).optional(),
})

const knowledgeSearchNode: NodeImplementation = {
	async *execute(context, node, nodeId): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = searchParams.parse(node.params)
		const query = resolveTemplate(params.query, scope(context))

		if (context.knowledgeBaseIds.length === 0) {
			return { text: "", values: { count: "0" } }
		}

		const outcome = await retrievalService.retrieve({
			workspaceId: context.workspaceId,
			knowledgeBaseIds: context.knowledgeBaseIds,
			question: query,
			topK: params.topK,
		})

		if (outcome.rerankUsage && outcome.rerankUsage.tokens > 0) {
			await context.charge({
				kind: "retrieval",
				nodeId,
				name: node.label || nodeId,
				provider: outcome.rerankUsage.provider,
				model: outcome.rerankUsage.model,
				operation: "rerank",
				inputTokens: outcome.rerankUsage.tokens,
				outputTokens: 0,
				estimated: outcome.rerankUsage.estimated,
			})
		} else {
			await context.record({
				nodeId,
				name: node.label || nodeId,
				ok: true,
				payload: { query },
				output: { results: outcome.chunks.length },
			})
		}

		// Numbered by the run, so a graph that searches at two nodes does not
		// produce two passages both called [[1]].
		const numbered = context.citations.add(outcome.chunks)
		if (outcome.chunks.length > 0) yield { type: "citations" }

		const text = outcome.chunks
			.map((chunk, position) => {
				const citation = numbered[position]
				const page = chunk.fromPage === null ? "" : ` (page ${chunk.fromPage})`
				return `[[${citation?.index ?? position + 1}]] source: ${chunk.documentName}${page}\n${chunk.content}`
			})
			.join("\n\n---\n\n")

		return {
			text: text || `No passage matched "${query}".`,
			values: { count: String(outcome.chunks.length), query },
		}
	},
}

const agentParams = z.object({
	prompt: z.string().min(1),
	system: z.string().default(""),
	tools: z.array(z.string()).max(8).default([]),
	maxRounds: z.number().int().min(1).max(10).default(3),
})

/**
 * A whole tool-using agent as one node.
 *
 * It runs the same loop a Phase 2 agent does — the one in `loop.ts` — rather
 * than a second implementation, so "how many rounds" and "what happens when a
 * tool fails" cannot answer differently depending on whether an agent is a graph
 * or not.
 */
const agentNode: NodeImplementation = {
	async *execute(context, node, nodeId): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = agentParams.parse(node.params)
		const prompt = resolveTemplate(params.prompt, scope(context))
		const system = resolveTemplate(params.system, scope(context))
		const tools = toolsFor(params.tools, context.knowledgeBaseIds, context.citations)

		const messages: ChatMessage[] = [
			...(system ? [{ role: "system" as const, content: system }] : []),
			{ role: "user" as const, content: prompt },
		]

		let text = ""
		for await (const event of runToolLoop(messages, {
			client: context.client,
			credential: context.credential,
			model: context.selection.model,
			temperature: context.temperature,
			maxTokens: context.maxOutputTokens,
			tools,
			maxRounds: params.maxRounds,
			toolContext: {
				workspaceId: context.workspaceId,
				projectId: context.projectId,
				userId: context.userId,
				runId: context.runId,
				signal: context.signal,
			},
			signal: context.signal,
		})) {
			if (event.type === "delta") yield { type: "delta", text: event.text }
			else if (event.type === "tool_started") {
				yield { type: "tool_started", name: event.name, arguments: event.arguments }
			} else if (event.type === "tool_finished") {
				yield { type: "tool_finished", name: event.name, ok: event.ok, summary: event.summary }
			} else if (event.type === "round_finished") {
				await context.charge({
					kind: "model",
					nodeId,
					name: node.label || nodeId,
					provider: context.selection.provider,
					model: context.selection.model,
					operation: "agent",
					inputTokens: event.charge.inputTokens,
					outputTokens: event.charge.outputTokens,
					estimated: event.charge.estimated,
					output: { toolCalls: event.charge.toolNames },
				})
			} else if (event.type === "tool_charge") {
				if (event.charge.usage) {
					await context.charge({
						kind: "tool",
						nodeId,
						name: event.charge.name,
						provider: event.charge.usage.provider,
						model: event.charge.usage.model,
						operation: event.charge.usage.operation,
						inputTokens: event.charge.usage.inputTokens,
						outputTokens: event.charge.usage.outputTokens,
						estimated: false,
						payload: { arguments: event.charge.arguments },
						output: event.charge.metadata,
					})
				} else {
					await context.record({
						nodeId,
						name: event.charge.name,
						ok: event.charge.ok,
						payload: { arguments: event.charge.arguments },
						output: { ...event.charge.metadata, preview: event.charge.content },
					})
				}
			} else if (event.type === "finished") text = event.text
		}

		return { text }
	},
}

const categorizeParams = z.object({
	input: z.string().min(1),
	categories: z
		.array(
			z.object({
				name: z.string().trim().min(1).max(60),
				description: z.string().trim().max(300).default(""),
				to: z.string().min(1),
			}),
		)
		.min(2)
		.max(8),
})

/**
 * Ask the model which branch to take.
 *
 * Deliberately not a free-form answer: the model is given the list and its reply
 * is matched against it, and an answer matching nothing takes the first category
 * rather than failing. A classifier that stops the whole flow because it
 * answered "Category: billing" instead of "billing" would be a bad trade.
 */
const categorizeNode: NodeImplementation = {
	async *execute(context, node, nodeId): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = categorizeParams.parse(node.params)
		const input = resolveTemplate(params.input, scope(context))

		const listing = params.categories
			.map((category) => `- ${category.name}: ${category.description || "(no description)"}`)
			.join("\n")

		const messages: ChatMessage[] = [
			{
				role: "system",
				content: `Classify the text into exactly one category. Reply with the category name alone and nothing else.\n\nCategories:\n${listing}`,
			},
			{ role: "user", content: input },
		]

		// `streamChat` rather than `chat`: it is the one method every chat-capable
		// client is guaranteed to have, and a classification is short enough that
		// collecting the stream costs nothing.
		let reply = ""
		let usage = { inputTokens: 0, outputTokens: 0 }
		for await (const event of context.client.streamChat(context.credential, {
			model: context.selection.model,
			messages,
			// Classification is not a place for sampling: the same input should
			// take the same branch every time.
			temperature: 0,
			maxTokens: 32,
			signal: context.signal,
		})) {
			if (event.type === "delta") reply += event.text
			else if (event.type === "done") usage = event.usage
		}

		await context.charge({
			kind: "model",
			nodeId,
			name: node.label || nodeId,
			provider: context.selection.provider,
			model: context.selection.model,
			operation: "agent",
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			estimated: usage.inputTokens === 0 && usage.outputTokens === 0,
			output: { answer: reply.slice(0, 200) },
		})

		const answer = reply.trim().toLowerCase()
		const chosen =
			params.categories.find((category) => answer === category.name.toLowerCase()) ??
			params.categories.find((category) => answer.includes(category.name.toLowerCase())) ??
			params.categories[0]!

		return {
			text: chosen.name,
			values: { category: chosen.name },
			next: [chosen.to],
		}
	},
}

const switchParams = z.object({
	cases: z
		.array(
			z.object({
				left: z.string(),
				operator: z.enum(["equals", "not_equals", "contains", "empty", "not_empty"]),
				right: z.string().default(""),
				to: z.string().min(1),
			}),
		)
		.min(1)
		.max(8),
	/** Taken when no case matches. Empty ends this branch. */
	otherwise: z.array(z.string()).max(4).default([]),
})

/** The first matching case wins, so order is meaningful and the canvas keeps it. */
const switchNode: NodeImplementation = {
	// eslint-disable-next-line require-yield
	async *execute(context, node): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = switchParams.parse(node.params)

		for (const branch of params.cases) {
			const left = resolveTemplate(branch.left, scope(context)).trim()
			const right = resolveTemplate(branch.right, scope(context)).trim()

			const matched =
				branch.operator === "equals"
					? left === right
					: branch.operator === "not_equals"
						? left !== right
						: branch.operator === "contains"
							? left.includes(right)
							: branch.operator === "empty"
								? left.length === 0
								: left.length > 0

			if (matched) return { text: branch.to, next: [branch.to] }
		}

		return { text: "", next: params.otherwise }
	},
}

const userInputParams = z.object({
	prompt: z.string().min(1),
	fields: z.array(z.string().trim().min(1).max(60)).min(1).max(6),
})

/**
 * Stop and ask a person.
 *
 * The node returns an `awaiting` marker and the engine saves the run's state and
 * returns — it does not block. A run waiting for a human may wait for days, and
 * an HTTP request cannot.
 *
 * On resume the answers are already in `values`, so the node finds them and
 * passes straight through. That is what makes resuming a re-run of the same
 * graph rather than a second code path.
 */
const userInputNode: NodeImplementation = {
	// eslint-disable-next-line require-yield
	async *execute(context, node, nodeId): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = userInputParams.parse(node.params)
		const answered = context.values[nodeId]

		if (answered && params.fields.every((field) => answered[field] !== undefined)) {
			return {
				text: params.fields.map((field) => `${field}: ${answered[field]}`).join("\n"),
				values: answered,
			}
		}

		return {
			text: "",
			awaiting: {
				prompt: resolveTemplate(params.prompt, scope(context)),
				fields: params.fields,
			},
		}
	},
}

const messageParams = z.object({ text: z.string().min(1) })

/** Says something to whoever is watching. Costs nothing — it calls no provider. */
const messageNode: NodeImplementation = {
	async *execute(context, node): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = messageParams.parse(node.params)
		const text = resolveTemplate(params.text, scope(context))
		if (text) yield { type: "delta", text }
		return { text }
	},
}

// ---------------------------------------------------------------------------
// Tool nodes. Seven node types, one implementation each of nothing.

/**
 * Runs a registry tool as a node.
 *
 * Every tool node below is this function plus a params schema. The capabilities
 * — OCR, transcription, a rendered page, a workbook — are already built and
 * already have one implementation each (`../tools/`); a node that re-did any of
 * them would be the second answer this phase exists to avoid, and the second
 * place for the SSRF check or the attachment scoping to be got wrong. What a
 * node adds is what the tool is given, and who is charged for it.
 */
async function* runToolNode(
	context: NodeContext,
	node: GraphNode,
	nodeId: string,
	toolId: ToolId,
	args: Record<string, unknown>,
): AsyncGenerator<NodeEvent, NodeOutput> {
	const [tool] = toolsFor([toolId], context.knowledgeBaseIds, context.citations)
	if (!tool) throw new ValidationError(`This deployment has no "${toolId}" step.`)

	const argumentsJson = JSON.stringify(args)
	yield { type: "tool_started", name: tool.name, arguments: argumentsJson }

	const result = await tool.execute(
		{
			// From the run, never from the node's params. A flow author who could
			// type a workspace id into a step would be typing somebody else's
			// (`.claude/rules/security.md`).
			workspaceId: context.workspaceId,
			projectId: context.projectId,
			userId: context.userId,
			runId: context.runId,
			// Names a generated artefact — `speech-{run}-{seq}.mp3` — and nothing
			// else. Storage keys come from the new row's id, so a repeated number
			// collides with nothing; `runner.ts` passes a constant here for the same
			// reason.
			stepSeq: 0,
			signal: context.signal,
		},
		args,
	)

	yield {
		type: "tool_finished",
		name: tool.name,
		ok: result.ok,
		summary: result.content.slice(0, 200),
	}

	if (result.usage) {
		await context.charge({
			kind: "tool",
			nodeId,
			name: node.label || tool.name,
			provider: result.usage.provider,
			model: result.usage.model,
			operation: result.usage.operation,
			inputTokens: result.usage.inputTokens,
			outputTokens: result.usage.outputTokens,
			estimated: false,
			payload: { arguments: argumentsJson },
			output: result.metadata,
		})
	} else {
		// No `usage` means there is nothing here to charge, and that is a decision
		// the tools already made rather than an omission. `http`, `excel` and
		// `browser` call no provider at all; the speech tools call one, but
		// `speechService` reserves and charges for it itself — which is also why
		// `charge` has no `"speech"` operation to widen it with. Charging here would
		// bill a workspace twice for one transcript.
		await context.record({
			nodeId,
			name: node.label || tool.name,
			ok: result.ok,
			payload: { arguments: argumentsJson },
			output: { ...result.metadata, preview: result.content.slice(0, 500) },
		})
	}

	return {
		// The tool's own text, fencing and all. Every one of these tools wraps what
		// it read in a line saying it is an observation and not an instruction, and
		// unwrapping it on the way into a flow's values would delete exactly the
		// sentence that keeps a transcribed voice note from being read as one
		// (`.claude/rules/security.md`).
		text: result.content,
		values: { ok: String(result.ok), ...carriedValues(result.metadata) },
	}
}

const httpNode: NodeImplementation = {
	async *execute(context, node, nodeId): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = httpNodeParams.parse(node.params)
		const body = resolveTemplate(params.body, scope(context))

		return yield* runToolNode(context, node, nodeId, "http_request", {
			url: resolveTemplate(params.url, scope(context)),
			method: params.method,
			...(body ? { body } : {}),
		})
	},
}

const ocrNode: NodeImplementation = {
	async *execute(context, node, nodeId): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = ocrNodeParams.parse(node.params)

		return yield* runToolNode(context, node, nodeId, "image_ocr", {
			attachmentId: resolveTemplate(params.attachmentId, scope(context)),
		})
	},
}

const visionNode: NodeImplementation = {
	async *execute(context, node, nodeId): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = visionNodeParams.parse(node.params)

		return yield* runToolNode(context, node, nodeId, "image_vision", {
			attachmentId: resolveTemplate(params.attachmentId, scope(context)),
			question: resolveTemplate(params.question, scope(context)),
		})
	},
}

const sttNode: NodeImplementation = {
	async *execute(context, node, nodeId): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = sttNodeParams.parse(node.params)

		return yield* runToolNode(context, node, nodeId, "speech_transcribe", {
			attachmentId: resolveTemplate(params.attachmentId, scope(context)),
			...(params.language ? { language: params.language } : {}),
		})
	},
}

const ttsNode: NodeImplementation = {
	async *execute(context, node, nodeId): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = ttsNodeParams.parse(node.params)

		// The recording comes back as an attachment id, not audio, so the id is what
		// the next step reads: `{{speak.attachmentId}}` (`speech-synthesize.tool.ts`).
		return yield* runToolNode(context, node, nodeId, "speech_synthesize", {
			text: resolveTemplate(params.text, scope(context)),
			...(params.voice ? { voice: params.voice } : {}),
		})
	},
}

const excelNode: NodeImplementation = {
	async *execute(context, node, nodeId): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = excelNodeParams.parse(node.params)

		if (params.operation === "read") {
			return yield* runToolNode(context, node, nodeId, "excel_read", {
				attachmentId: resolveTemplate(params.attachmentId, scope(context)),
				...(params.sheet ? { sheet: params.sheet } : {}),
			})
		}

		return yield* runToolNode(context, node, nodeId, "excel_write", {
			...(params.fileName ? { fileName: params.fileName } : {}),
			sheets: params.sheets.map((sheet) => ({
				name: sheet.name,
				// Per cell, so a row can be built out of what earlier nodes produced —
				// which is the whole reason a flow writes a spreadsheet at all.
				rows: sheet.rows.map((row) => row.map((cell) => resolveTemplate(cell, scope(context)))),
			})),
		})
	},
}

const browserNode: NodeImplementation = {
	async *execute(context, node, nodeId): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = browserNodeParams.parse(node.params)

		return yield* runToolNode(context, node, nodeId, "browser_read", {
			url: resolveTemplate(params.url, scope(context)),
			...(params.selectors ? { selectors: params.selectors } : {}),
		})
	},
}

/**
 * Walk a list, running one node per item.
 *
 * ADR-031 deferred this because iteration seemed to need a second execution
 * model — a sub-graph with its own frontier and its own variable scope. It does
 * not, as long as the body is **one node**: the loop asks the engine to run that
 * node once per item and hands the frontier back a `next` that leaves the body
 * out of it, so the frontier never sees the body at all and cannot double-run
 * it. A body of several nodes would need the sub-graph, and is not this.
 *
 * **It cannot run forever.** Three bounds, and the run's budget is the one that
 * decides: `maxIterations` is what the flow author asked for,
 * `MAX_LOOP_ITERATIONS` is the most anyone may ask for, and what is left of
 * `MAX_NODE_EXECUTIONS` is what the run can still afford — every iteration
 * spends from the same budget every other node spends from, counted by the
 * engine rather than here. A list longer than the smallest of the three is
 * truncated, and the output says so rather than quietly answering from part of
 * it.
 *
 * **A loop is one node, so it is one checkpoint.** A run interrupted half way
 * through a list resumes at the top of the loop and pays for the finished
 * iterations again — the node boundary is where the engine can restart, and
 * there is no half-finished node to resume into (`../checkpoint.ts`). With a
 * ceiling of 25 iterations that is a bounded cost, and an iteration index in the
 * checkpoint would be a second thing that has to agree with `completed` about
 * what has already happened.
 */
const loopNode: NodeImplementation = {
	async *execute(context, node): AsyncGenerator<NodeEvent, NodeOutput> {
		const params = loopNodeParams.parse(node.params)
		const { runBody, remainingExecutions } = context
		if (!runBody || !remainingExecutions) {
			throw new ValidationError("A loop step only runs as part of a flow.")
		}

		const items = parseLoopItems(resolveTemplate(params.items, scope(context)), params.format)
		const planned = plannedIterations({
			items: items.length,
			maxIterations: params.maxIterations,
			remaining: remainingExecutions(),
		})

		const outputs: string[] = []
		try {
			for (let index = 0; index < planned; index += 1) {
				// The body reads its item out of the run's own value scope, so it is an
				// ordinary node that knows nothing about being looped over. Mutated in
				// place rather than replaced: the engine holds a reference to this
				// object, and a fresh one would not be the one it snapshots.
				context.values[LOOP_SCOPE] = { item: items[index]!, index: String(index) }
				// A body that branches has nowhere to branch to — the frontier is not
				// running it — so its `next` is ignored, and only its text is collected.
				const result = yield* runBody(params.body)
				outputs.push(result.text)
			}
		} finally {
			// The scope belongs to the loop, not to the run. Left behind,
			// `{{loop.item}}` would keep resolving to the last item in every node
			// after this one.
			delete context.values[LOOP_SCOPE]
		}

		const truncated = planned < items.length
		const text = [
			outputs.join("\n\n"),
			truncated
				? `[The list had ${items.length} items and this flow ran the first ${planned}.]`
				: "",
		]
			.filter(Boolean)
			.join("\n\n")

		return {
			text,
			values: {
				count: String(planned),
				items: String(items.length),
				truncated: String(truncated),
			},
			// The body is this node's to run and nobody else's. Leaving it in what the
			// frontier reaches would run it once more after the loop, on whatever
			// `{{loop.item}}` no longer resolves to.
			next: node.downstream.filter((id) => id !== params.body),
		}
	},
}

export const NODE_IMPLEMENTATIONS = {
	begin: beginNode,
	llm: llmNode,
	knowledge_search: knowledgeSearchNode,
	agent: agentNode,
	categorize: categorizeNode,
	switch: switchNode,
	user_input: userInputNode,
	message: messageNode,
	http: httpNode,
	ocr: ocrNode,
	vision: visionNode,
	stt: sttNode,
	tts: ttsNode,
	excel: excelNode,
	browser: browserNode,
	loop: loopNode,
} as const satisfies Record<string, NodeImplementation>
