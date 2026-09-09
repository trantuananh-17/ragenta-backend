import { NODE_TYPES, agentGraphSchema, validateGraph } from "./types"
import type { AgentGraph } from "./types"
import { unfence } from "./node-params"

/**
 * Turning a sentence into a draft flow.
 *
 * The canvas is the slowest part of building an agent and the hardest to start:
 * a blank graph gives no clue which of seventeen node types the job needs. This
 * turns "read yesterday's mail and flag what matters" into a shape somebody can
 * correct, which is a different and much easier task than composing one.
 *
 * **Everything a model returns is treated as a proposal, never as a graph.** It
 * is parsed, schema-checked and run through the same `validateGraph` the publish
 * path uses, and anything that fails comes back as a list of problems. A model
 * inventing a node type that does not exist is not a risk to guard against — it
 * is a certainty, and the only question is whether it reaches the canvas.
 *
 * Splitting the parsing out from the model call is what makes that testable
 * without a provider key or a database, the same reason `credits.ts` is separate
 * from `pricing.ts`.
 */

/**
 * What each node is for, in one line, because the model has to choose between
 * them from the name alone otherwise. Only the four commonest carry their
 * parameter names: a draft that fills `params` it is unsure of produces a graph
 * that looks finished and fails on the first run, which is worse than one that
 * is visibly incomplete.
 */
const NODE_GUIDE: Record<string, string> = {
	begin: "The entry point. Exactly one, always called `begin`. No params.",
	llm: "Ask a model. params: { prompt: string, system?: string }",
	knowledge_search:
		"Search the workspace's knowledge bases. params: { query: string, topK?: number }",
	agent: "Call another agent in this workspace.",
	categorize:
		"Sort text into one of a fixed set. params: { input: string, categories: string }",
	switch: "Take a different branch depending on a value.",
	user_input: "Pause and ask the person for more before carrying on.",
	message: "Emit text to the caller. params: { text: string }",
	http: "Call an external HTTP API.",
	ocr: "Read text out of an image or a PDF.",
	vision: "Describe or answer questions about an image.",
	stt: "Transcribe audio to text.",
	tts: "Turn text into speech.",
	excel: "Read or write a spreadsheet.",
	browser: "Fetch and read a web page.",
	loop: "Run the nodes inside it once per item.",
}

export function buildGraphMessages(prompt: string) {
	const catalogue = NODE_TYPES.map((type) => `- ${type}: ${NODE_GUIDE[type] ?? ""}`).join("\n")

	return [
		{
			role: "system" as const,
			content: [
				"You design agent flows as a directed graph. Answer with JSON only.",
				"",
				"Shape:",
				'{"nodes":{"begin":{"type":"begin","label":"Start","params":{},"upstream":[],"downstream":["ask"]},"ask":{"type":"llm","label":"Answer","params":{"prompt":"{{sys.input}}"},"upstream":["begin"],"downstream":[]}}}',
				"",
				"The node types you may use, and nothing else:",
				catalogue,
				"",
				"Rules:",
				"- Exactly one node with id `begin`, of type `begin`. Every other node must be reachable from it.",
				"- `upstream` and `downstream` must name ids that exist in this same object, and must agree with each other.",
				"- No cycles, except inside a `loop` node's body.",
				"- Node ids are short, lower_snake_case, and never `sys` or `loop`.",
				"- `{{sys.input}}` is the run's input. `{{some_node.text}}` is what that node produced.",
				"- Leave `params` as {} for any node whose parameters you are not sure of. A human will fill them in. Do not invent file paths, URLs, ids or credentials.",
				"- Prefer few nodes. Four that work beat ten that need untangling.",
				'- If the request cannot be built from these node types, answer {"error":"..."} naming what is missing. Never substitute a node type that does not exist.',
			].join("\n"),
		},
		{
			role: "user" as const,
			content: `Build a flow that does this: ${prompt}`,
		},
	]
}

export type GeneratedGraph = { graph: AgentGraph } | { errors: string[] }

/**
 * Reads a model's answer into a graph, or into the reasons it is not one.
 *
 * Pure, and the whole point of this module: a malformed proposal must fail here,
 * loudly, rather than reaching a canvas — where a dangling edge is a graph
 * somebody publishes and only finds out about on a charged run.
 */
export function parseGeneratedGraph(text: string): GeneratedGraph {
	let parsed: unknown
	try {
		parsed = JSON.parse(unfence(text))
	} catch {
		return { errors: ["The model did not answer with JSON."] }
	}

	if (typeof parsed !== "object" || parsed === null) {
		return { errors: ["The model did not answer with JSON."] }
	}

	// The refusal the prompt asks for when the request cannot be built. Passed
	// through as the model wrote it: it names the capability that is missing,
	// which is more useful than "generation failed".
	const refusal = (parsed as { error?: unknown }).error
	if (typeof refusal === "string" && refusal.trim()) return { errors: [refusal.trim()] }

	const shape = agentGraphSchema.safeParse(parsed)
	if (!shape.success) {
		return {
			errors: shape.error.issues.slice(0, 8).map((issue) => {
				const where = issue.path.join(".")
				return where ? `${where}: ${issue.message}` : issue.message
			}),
		}
	}

	const problems = validateGraph(shape.data)
	if (problems.length > 0) return { errors: problems }

	return { graph: shape.data }
}
