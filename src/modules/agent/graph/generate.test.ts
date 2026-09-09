import { describe, expect, it } from "vitest"

import { buildGraphMessages, parseGeneratedGraph } from "./generate"

/**
 * What a model is allowed to put on somebody's canvas.
 *
 * These are not hypotheticals. A model asked for a flow will invent a node type
 * that sounds right, name an edge that goes nowhere, and forget the entry point
 * — and any one of those reaching the editor is a graph a person then publishes
 * and discovers on a charged run. Every case below is a refusal, and the refusal
 * has to say which part was wrong.
 *
 * No provider and no database: the parsing is separate from the model call
 * precisely so this suite can exist.
 */

const valid = {
	nodes: {
		begin: {
			type: "begin",
			label: "Start",
			params: {},
			upstream: [],
			downstream: ["answer"],
		},
		answer: {
			type: "llm",
			label: "Answer",
			params: { prompt: "{{sys.input}}" },
			upstream: ["begin"],
			downstream: [],
		},
	},
}

function reject(payload: unknown): string[] {
	const result = parseGeneratedGraph(JSON.stringify(payload))
	if ("graph" in result) throw new Error("expected a refusal, got a graph")
	return result.errors
}

describe("parseGeneratedGraph", () => {
	it("accepts a graph that is actually one", () => {
		const result = parseGeneratedGraph(JSON.stringify(valid))
		expect("graph" in result).toBe(true)
	})

	it("reads a graph out of a fenced code block", () => {
		// Models wrap JSON in ```json far more often than not, and a refusal over
		// punctuation would make the feature look broken rather than strict.
		const fenced = "```json\n" + JSON.stringify(valid) + "\n```"
		expect("graph" in parseGeneratedGraph(fenced)).toBe(true)
	})

	it("refuses prose", () => {
		const result = parseGeneratedGraph("Sure! Here is a flow you could use.")
		expect(result).toEqual({ errors: ["The model did not answer with JSON."] })
	})

	it("passes a model's own refusal through in its own words", () => {
		// It names the capability that is missing, which beats "generation failed".
		const result = parseGeneratedGraph('{"error":"There is no node that posts to Slack."}')
		expect(result).toEqual({ errors: ["There is no node that posts to Slack."] })
	})

	it("refuses a node type that does not exist", () => {
		const errors = reject({
			nodes: {
				begin: { type: "begin", params: {}, upstream: [], downstream: ["slack"] },
				slack: { type: "slack", params: {}, upstream: ["begin"], downstream: [] },
			},
		})
		expect(errors.join(" ")).toMatch(/slack/)
	})

	it("refuses a graph with no begin", () => {
		const errors = reject({
			nodes: {
				answer: { type: "llm", params: {}, upstream: [], downstream: [] },
			},
		})
		expect(errors.join(" ")).toMatch(/begin/)
	})

	it("refuses an edge that names a node which is not there", () => {
		const errors = reject({
			nodes: {
				begin: { type: "begin", params: {}, upstream: [], downstream: ["ghost"] },
			},
		})
		expect(errors.length).toBeGreaterThan(0)
	})

	it("refuses a begin node that is not of type begin", () => {
		const errors = reject({
			nodes: {
				begin: { type: "llm", params: {}, upstream: [], downstream: [] },
			},
		})
		expect(errors.join(" ")).toMatch(/begin/)
	})

	it("refuses something that is not an object at all", () => {
		expect(parseGeneratedGraph("[]")).toHaveProperty("errors")
		expect(parseGeneratedGraph("null")).toEqual({
			errors: ["The model did not answer with JSON."],
		})
	})
})

describe("buildGraphMessages", () => {
	it("names every node type the graph accepts", () => {
		const [system] = buildGraphMessages("read my mail")
		if (!system) throw new Error("no system message")
		expect(system.content).toContain("begin")
		// The catalogue is generated from NODE_TYPES rather than typed out, so a
		// node added to the product cannot be one the model is never told about.
		expect(system.content).toContain("knowledge_search")
		expect(system.content).toContain("categorize")
		expect(system.content).toContain("loop")
	})

	it("names the tools an agent node can reach", () => {
		const [system] = buildGraphMessages("read my mail")
		if (!system) throw new Error("no system message")
		// The first draft of this prompt listed node types and nothing else, so a
		// model asked to read email refused: no *node type* reads email, and it had
		// not been told that `gmail_search` exists as a tool on an `agent` node.
		expect(system.content).toContain("gmail_search")
		expect(system.content).toContain("slack_post")
		expect(system.content).toContain("web_search")
	})

	it("shows a worked example that reaches a tool through an agent node", () => {
		const [system] = buildGraphMessages("read my mail")
		if (!system) throw new Error("no system message")
		// Describing the tool path was not enough on its own: the model kept echoing
		// the refusal rule back instead of using an `agent` node, so the path it
		// should take is demonstrated rather than only explained.
		expect(system.content).toContain('"type":"agent"')
		expect(system.content).toContain('"tools":["gmail_search"]')
	})

	it("carries the request as the user turn", () => {
		const [, user] = buildGraphMessages("read my mail")
		if (!user) throw new Error("no user message")
		expect(user.content).toContain("read my mail")
	})
})
