import { describe, expect, it } from "vitest"

import { DIFFED_FIELDS, diffVersions } from "./version-diff"

/** A version row as Postgres hands it back: numerics are strings. */
function version(overrides: Record<string, unknown> = {}) {
	return {
		id: "ver_1",
		agentId: "agent_1",
		version: 1,
		createdAt: new Date("2026-01-01"),
		createdBy: "user_1",
		instructions: "Answer from the documents.",
		provider: "openai",
		model: "gpt-5",
		temperature: "0.70",
		maxOutputTokens: 2_000,
		knowledgeBaseIds: ["kb_1", "kb_2"],
		searchMode: "hybrid",
		topK: 8,
		similarityThreshold: null,
		vectorWeight: null,
		rerankProvider: null,
		rerankModel: null,
		groundedOnly: true,
		tools: ["knowledge_search"],
		maxRounds: 4,
		creditCeiling: null,
		approveWrites: true,
		memoryEnabled: false,
		memoryScope: "agent",
		memoryTopK: 5,
		graph: null,
		...overrides,
	}
}

describe("diffVersions", () => {
	it("reports nothing when the two versions are the same", () => {
		expect(diffVersions(version(), version())).toEqual([])
	})

	/**
	 * The fields that differ between *any* two versions and mean nothing. A diff
	 * that included them would bury the one line somebody is looking for under
	 * three that are true of every pair.
	 */
	it("ignores the id, the version number and who created it", () => {
		const changes = diffVersions(
			version(),
			version({ id: "ver_2", version: 2, createdAt: new Date("2026-02-01"), createdBy: "user_2" }),
		)
		expect(changes).toEqual([])
		expect(DIFFED_FIELDS).not.toContain("id")
		expect(DIFFED_FIELDS).not.toContain("version")
		expect(DIFFED_FIELDS).not.toContain("createdAt")
		expect(DIFFED_FIELDS).not.toContain("createdBy")
	})

	it("reports a changed brief", () => {
		const changes = diffVersions(version(), version({ instructions: "Be brief." }))
		expect(changes).toHaveLength(1)
		expect(changes[0]).toMatchObject({
			field: "instructions",
			label: "Instructions",
			kind: "text",
			before: "Answer from the documents.",
			after: "Be brief.",
		})
	})

	/**
	 * Numeric columns come back from Postgres as strings, so the same temperature
	 * written two ways must not read as an edit. This is the bug this comparison
	 * exists to avoid: a diff that cried wolf on every publish would be ignored.
	 */
	it("does not report a numeric that only changed spelling", () => {
		expect(diffVersions(version({ temperature: "0.70" }), version({ temperature: 0.7 }))).toEqual(
			[],
		)
		expect(diffVersions(version({ creditCeiling: "100.0000" }), version({ creditCeiling: 100 }))).toEqual(
			[],
		)
	})

	it("still reports a numeric that actually changed", () => {
		const changes = diffVersions(version({ temperature: "0.70" }), version({ temperature: "0.20" }))
		expect(changes).toHaveLength(1)
		expect(changes[0]?.field).toBe("temperature")
	})

	it("does not treat a reordered list as a change", () => {
		const changes = diffVersions(
			version({ tools: ["web_search", "knowledge_search"] }),
			version({ tools: ["knowledge_search", "web_search"] }),
		)
		expect(changes).toEqual([])
	})

	it("reports a tool added and a tool removed", () => {
		const added = diffVersions(version(), version({ tools: ["knowledge_search", "web_search"] }))
		expect(added).toHaveLength(1)
		expect(added[0]?.kind).toBe("list")

		const removed = diffVersions(version(), version({ tools: [] }))
		expect(removed).toHaveLength(1)
	})

	it("reports a setting turned on or off", () => {
		const changes = diffVersions(version(), version({ memoryEnabled: true }))
		expect(changes).toHaveLength(1)
		expect(changes[0]).toMatchObject({ field: "memoryEnabled", before: false, after: true })
	})

	it("treats null and undefined as the same absence", () => {
		expect(diffVersions(version({ topK: null }), version({ topK: undefined }))).toEqual([])
	})

	it("reports a value that was cleared", () => {
		const changes = diffVersions(version({ topK: 8 }), version({ topK: null }))
		expect(changes).toHaveLength(1)
		expect(changes[0]).toMatchObject({ field: "topK", before: 8, after: null })
	})

	/**
	 * An empty string is not zero. `Number("")` is 0, so a naive numeric
	 * comparison would call a cleared model name equal to a model named "0".
	 */
	it("does not treat an empty string as zero", () => {
		const changes = diffVersions(version({ model: "0" }), version({ model: "" }))
		expect(changes).toHaveLength(1)
	})

	it("reports a flow appearing, changing and going away", () => {
		const graph = { nodes: [{ id: "a" }], edges: [] }
		expect(diffVersions(version(), version({ graph }))).toHaveLength(1)
		expect(
			diffVersions(version({ graph }), version({ graph: { nodes: [{ id: "b" }], edges: [] } })),
		).toHaveLength(1)
		expect(diffVersions(version({ graph }), version())).toHaveLength(1)
		expect(diffVersions(version({ graph }), version({ graph }))).toEqual([])
	})

	it("returns changes in the order the configuration form shows them", () => {
		const changes = diffVersions(
			version(),
			version({ maxRounds: 8, instructions: "Different.", tools: [] }),
		)
		expect(changes.map((change) => change.field)).toEqual([
			"instructions",
			"tools",
			"maxRounds",
		])
	})
})
