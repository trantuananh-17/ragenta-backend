import { describe, expect, it } from "vitest"

import {
	MAX_LOOP_ITERATIONS,
	browserNodeParams,
	carriedValues,
	excelNodeParams,
	httpNodeParams,
	loopNodeParams,
	parseLoopItems,
	plannedIterations,
	sttNodeParams,
	ttsNodeParams,
	visionNodeParams,
} from "./node-params"
import { agentGraphSchema, resolveTemplate, validateGraph } from "./types"

describe("tool node params", () => {
	it("defaults an http step to GET with no body", () => {
		const params = httpNodeParams.parse({ url: "https://example.test/status" })

		expect(params).toEqual({ url: "https://example.test/status", method: "GET", body: "" })
	})

	it("accepts a template where the tool expects a URL", () => {
		// The template is not a URL until it is resolved, so the shape is the
		// tool's check and not this schema's.
		const params = httpNodeParams.parse({ url: "{{find.text}}", method: "POST" })

		expect(params.url).toBe("{{find.text}}")
	})

	it("refuses an http method the tool cannot make", () => {
		expect(httpNodeParams.safeParse({ url: "https://example.test", method: "DELETE" }).success).toBe(
			false,
		)
	})

	it("requires both an attachment and a question of a vision step", () => {
		expect(visionNodeParams.safeParse({ attachmentId: "att_1" }).success).toBe(false)
		expect(
			visionNodeParams.safeParse({ attachmentId: "att_1", question: "What does it show?" }).success,
		).toBe(true)
	})

	it("takes a two-letter language for a transcription step, or none", () => {
		expect(sttNodeParams.parse({ attachmentId: "att_1" }).language).toBeUndefined()
		expect(sttNodeParams.parse({ attachmentId: "att_1", language: "vi" }).language).toBe("vi")
		expect(sttNodeParams.safeParse({ attachmentId: "att_1", language: "vie" }).success).toBe(false)
	})

	it("keeps the voice optional on a speech step", () => {
		expect(ttsNodeParams.parse({ text: "{{answer.text}}" }).voice).toBeUndefined()
		expect(ttsNodeParams.safeParse({ text: "" }).success).toBe(false)
	})

	it("branches a spreadsheet step on its operation", () => {
		const read = excelNodeParams.parse({ operation: "read", attachmentId: "att_1" })
		expect(read.operation).toBe("read")

		const written = excelNodeParams.parse({
			operation: "write",
			sheets: [{ name: "Invoices", rows: [["Id", "Total"], ["{{row.id}}", "{{row.total}}"]] }],
		})
		expect(written.operation === "write" && written.sheets[0]?.rows).toHaveLength(2)

		expect(excelNodeParams.safeParse({ operation: "append", attachmentId: "att_1" }).success).toBe(
			false,
		)
		// A read's fields on a write is a different node's configuration.
		expect(excelNodeParams.safeParse({ operation: "write", attachmentId: "att_1" }).success).toBe(
			false,
		)
	})

	it("caps a browser step's selectors at what the tool accepts", () => {
		expect(browserNodeParams.parse({ url: "https://example.test" }).selectors).toBeUndefined()
		expect(
			browserNodeParams.safeParse({
				url: "https://example.test",
				selectors: ["h1", "h2", "h3", "h4", "h5", "h6"],
			}).success,
		).toBe(false)
	})
})

describe("loop params", () => {
	it("defaults to a line per item and ten iterations", () => {
		const params = loopNodeParams.parse({ items: "{{list.text}}", body: "summarise" })

		expect(params).toEqual({
			items: "{{list.text}}",
			format: "lines",
			body: "summarise",
			maxIterations: 10,
		})
	})

	it("refuses a loop that would run no times or more than the ceiling", () => {
		const base = { items: "{{list.text}}", body: "summarise" }

		expect(loopNodeParams.safeParse({ ...base, maxIterations: 0 }).success).toBe(false)
		expect(loopNodeParams.safeParse({ ...base, maxIterations: 2.5 }).success).toBe(false)
		expect(loopNodeParams.safeParse({ ...base, maxIterations: MAX_LOOP_ITERATIONS }).success).toBe(
			true,
		)
		expect(
			loopNodeParams.safeParse({ ...base, maxIterations: MAX_LOOP_ITERATIONS + 1 }).success,
		).toBe(false)
	})

	it("needs a body node to run", () => {
		expect(loopNodeParams.safeParse({ items: "{{list.text}}" }).success).toBe(false)
	})
})

describe("parseLoopItems", () => {
	it("takes a line per item, trimmed, without the blanks", () => {
		expect(parseLoopItems("  first \r\n\n second\n\n", "lines")).toEqual(["first", "second"])
	})

	it("returns nothing for an empty list rather than one empty item", () => {
		expect(parseLoopItems("   \n \n", "lines")).toEqual([])
		expect(parseLoopItems("[]", "json")).toEqual([])
	})

	it("passes JSON strings through untouched and stringifies the rest", () => {
		expect(parseLoopItems('["att_1", 2, {"id":"x"}]', "json")).toEqual([
			"att_1",
			"2",
			'{"id":"x"}',
		])
	})

	it("refuses JSON that is not a list", () => {
		// Looping once over an object looks like it worked and is not what anyone
		// configured.
		expect(() => parseLoopItems('{"rows":["a"]}', "json")).toThrow(/list/)
		expect(() => parseLoopItems("not json at all", "json")).toThrow(/list/)
	})
})

describe("plannedIterations", () => {
	it("runs every item when nothing is in the way", () => {
		expect(plannedIterations({ items: 3, maxIterations: 10, remaining: 40 })).toBe(3)
	})

	it("stops at what the flow asked for", () => {
		expect(plannedIterations({ items: 100, maxIterations: 10, remaining: 40 })).toBe(10)
	})

	it("stops at what the run can still afford", () => {
		// The bound that matters: the flow author's number does not buy budget the
		// rest of the run was counting on.
		expect(plannedIterations({ items: 100, maxIterations: 25, remaining: 4 })).toBe(4)
	})

	it("runs nothing at all when the budget is gone", () => {
		expect(plannedIterations({ items: 100, maxIterations: 25, remaining: 0 })).toBe(0)
		expect(plannedIterations({ items: 100, maxIterations: 25, remaining: -3 })).toBe(0)
	})

	it("runs nothing for an empty list", () => {
		expect(plannedIterations({ items: 0, maxIterations: 25, remaining: 50 })).toBe(0)
	})
})

describe("carriedValues", () => {
	it("carries the fields a later step can reference, as strings", () => {
		expect(
			carriedValues({ attachmentId: "att_9", status: 200, cached: true, language: "en" }),
		).toEqual({ attachmentId: "att_9", status: "200", cached: "true", language: "en" })
	})

	it("leaves out everything else, including structures", () => {
		expect(carriedValues({ sheets: [{ name: "One" }], passes: { tokens: 4 }, title: "A page" })).toEqual(
			{},
		)
		expect(carriedValues(undefined)).toEqual({})
	})
})

describe("loop templates", () => {
	it("resolves the item and the index a body reads", () => {
		expect(
			resolveTemplate("{{loop.index}}: {{loop.item}}", {
				loop: { item: "att_1", index: "0" },
			}),
		).toBe("0: att_1")
	})

	it("resolves to nothing once the loop has finished with the scope", () => {
		expect(resolveTemplate("[{{loop.item}}]", { sys: { input: "hello" } })).toBe("[]")
	})
})

/** begin → loop → body, then a message the loop leads to after the list. */
function loopGraph(overrides: Record<string, unknown> = {}) {
	return agentGraphSchema.parse({
		nodes: {
			begin: { type: "begin", downstream: ["walk"] },
			walk: {
				type: "loop",
				upstream: ["begin"],
				downstream: ["summarise", "done"],
				params: { items: "{{begin.text}}", body: "summarise" },
			},
			summarise: { type: "llm", upstream: ["walk"], params: { prompt: "{{loop.item}}" } },
			done: { type: "message", upstream: ["walk"], params: { text: "{{walk.count}} done" } },
			...overrides,
		},
	})
}

describe("validateGraph, for loops", () => {
	it("accepts a loop whose body is reached only by it", () => {
		expect(validateGraph(loopGraph())).toEqual([])
	})

	it("refuses a loop with no body named", () => {
		const graph = loopGraph({
			walk: { type: "loop", upstream: ["begin"], downstream: ["summarise", "done"], params: {} },
		})

		expect(validateGraph(graph)).toContain('"walk" is a loop, so it needs a body node to run for each item.')
	})

	it("refuses a body that is not in the graph", () => {
		const graph = loopGraph({
			walk: {
				type: "loop",
				upstream: ["begin"],
				downstream: ["summarise", "done"],
				params: { items: "{{begin.text}}", body: "missing" },
			},
		})

		expect(validateGraph(graph)).toContain('"walk" loops over "missing", which is not in the graph.')
	})

	it("refuses a body anything else also leads to", () => {
		// It would run once per item inside the loop and once more on the
		// frontier, and be charged for both.
		const graph = loopGraph({
			begin: { type: "begin", downstream: ["walk", "summarise"] },
			summarise: {
				type: "llm",
				upstream: ["walk", "begin"],
				params: { prompt: "{{loop.item}}" },
			},
		})

		expect(validateGraph(graph)).toContain(
			'"walk" must be the only thing leading to its loop body "summarise".',
		)
	})

	it("refuses a body with a branch of its own", () => {
		const graph = loopGraph({
			summarise: {
				type: "llm",
				upstream: ["walk"],
				downstream: ["done"],
				params: { prompt: "{{loop.item}}" },
			},
			done: { type: "message", upstream: ["walk", "summarise"], params: { text: "done" } },
		})

		expect(validateGraph(graph)).toContain(
			'Nothing runs after the loop body "summarise" — put what comes next after "walk" instead.',
		)
	})

	it("refuses a loop inside a loop and a body that stops for a person", () => {
		const nested = loopGraph({
			summarise: {
				type: "loop",
				upstream: ["walk"],
				params: { items: "{{loop.item}}", body: "walk" },
			},
		})
		expect(validateGraph(nested)).toContain(
			'"summarise" cannot be a loop body: a loop inside a loop is not supported.',
		)

		const asks = loopGraph({
			summarise: {
				type: "user_input",
				upstream: ["walk"],
				params: { prompt: "Which one?", fields: ["choice"] },
			},
		})
		expect(validateGraph(asks)).toContain(
			'"summarise" cannot be a loop body: a run that stops to ask a person cannot be resumed part-way through a list.',
		)
	})

	it("refuses a node named after a value scope", () => {
		const graph = agentGraphSchema.parse({
			nodes: {
				begin: { type: "begin", downstream: ["loop"] },
				loop: { type: "message", upstream: ["begin"], params: { text: "hello" } },
			},
		})

		expect(validateGraph(graph)).toContain('"loop" is a reserved name — a template already resolves it.')
	})
})
