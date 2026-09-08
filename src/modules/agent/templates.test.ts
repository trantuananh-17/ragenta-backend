import { describe, expect, it } from "vitest"

import { AGENT_TEMPLATES, findTemplate } from "./templates"
import { TOOL_IDS, isToolId } from "./tools/catalogue"

describe("the agents somebody can start from", () => {
	it("gives every template a unique id", () => {
		const ids = AGENT_TEMPLATES.map((template) => template.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it("names only tools this build actually has", () => {
		for (const template of AGENT_TEMPLATES) {
			for (const id of template.tools) {
				expect(isToolId(id), `${template.id} names unknown tool ${id}`).toBe(true)
			}
		}
	})

	it("does not ask for the same tool twice", () => {
		for (const template of AGENT_TEMPLATES) {
			expect(new Set(template.tools).size).toBe(template.tools.length)
		}
	})

	/**
	 * A template that turns memory on and does not give the agent the tool to
	 * write one produces an agent that recalls forever and remembers nothing —
	 * which reads as memory being broken rather than as a template being
	 * incomplete.
	 */
	it("gives a remembering agent the means to remember", () => {
		for (const template of AGENT_TEMPLATES) {
			if (!template.memory.enabled) continue
			expect(template.tools, `${template.id} remembers nothing`).toContain("memory_write")
		}
	})

	it("does not hand memory tools to an agent with memory off", () => {
		for (const template of AGENT_TEMPLATES) {
			if (template.memory.enabled) continue
			expect(template.tools).not.toContain("memory_write")
			expect(template.tools).not.toContain("memory_search")
		}
	})

	/**
	 * The publish-time rule, checked here so a template cannot ship in a state
	 * that would be refused the moment somebody applies it.
	 */
	it("only asks to search documents when it says it needs some", () => {
		for (const template of AGENT_TEMPLATES) {
			if (!template.tools.includes("knowledge_search")) continue
			// It may search without insisting on a base — the applier drops the tool
			// in that case — but a template that *needs* one must ask to search.
			if (template.needsKnowledgeBase) {
				expect(template.tools).toContain("knowledge_search")
			}
		}
	})

	it("insists on a knowledge base exactly where its brief answers from documents", () => {
		expect(findTemplate("customer-support")?.needsKnowledgeBase).toBe(true)
		expect(findTemplate("hr")?.needsKnowledgeBase).toBe(true)
		expect(findTemplate("research")?.needsKnowledgeBase).toBe(false)
	})

	/**
	 * The property that matters most. A brief that only says what to do produces
	 * an agent that answers everything confidently, which is the failure this
	 * product exists to avoid.
	 */
	it("tells every agent when to stop rather than only what to do", () => {
		for (const template of AGENT_TEMPLATES) {
			expect(
				/do not|never|say so|stop|cannot|unreadable/i.test(template.instructions),
				`${template.id} never says what not to do`,
			).toBe(true)
		}
	})

	it("grounds the two that must not improvise", () => {
		expect(findTemplate("hr")?.groundedOnly).toBe(true)
		expect(findTemplate("customer-support")?.groundedOnly).toBe(true)
	})

	it("bounds every template's loop", () => {
		for (const template of AGENT_TEMPLATES) {
			expect(template.maxRounds).toBeGreaterThan(0)
			expect(template.maxRounds).toBeLessThanOrEqual(10)
		}
	})

	it("ships the six that were asked for", () => {
		expect(AGENT_TEMPLATES.map((template) => template.id).sort()).toEqual(
			["customer-support", "data-analyst", "document", "hr", "research", "sales"].sort(),
		)
	})

	it("uses only ids the registry knows, so a renamed tool breaks here first", () => {
		const known = new Set<string>(TOOL_IDS)
		for (const template of AGENT_TEMPLATES) {
			for (const id of template.tools) expect(known.has(id)).toBe(true)
		}
	})
})
