import { describe, expect, it } from "vitest"

import { historyMessages } from "./history-content"

describe("historyMessages", () => {
	it("alternates user and assistant, oldest first", () => {
		expect(
			historyMessages([
				{ question: "Do you ship to Hue?", answer: "Yes, in two days." },
				{ question: "And in blue?", answer: "Blue is in stock." },
			]),
		).toEqual([
			{ role: "user", content: "Do you ship to Hue?" },
			{ role: "assistant", content: "Yes, in two days." },
			{ role: "user", content: "And in blue?" },
			{ role: "assistant", content: "Blue is in stock." },
		])
	})

	it("is empty when there are no turns", () => {
		expect(historyMessages([])).toEqual([])
	})
})
