import { describe, expect, it } from "vitest"

import { normalizeExtraction, normalizeFieldsReply } from "./normalize"

/**
 * What a model's reply becomes once it is on its way into `message_attachment`.
 *
 * This is the file that decides whether an odd reply costs the user their
 * attachment or costs them nothing at all, so the cases here are the ones seen
 * in the wild rather than the ones the prompt asks for: fences, an apology in
 * front of the JSON, a truncated object, a number where a string was specified.
 */

const SOURCE = { provider: "openai", model: "gpt-4o" }

describe("normalizeExtraction", () => {
	it("reads a clean JSON reply", () => {
		const result = normalizeExtraction(
			JSON.stringify({ text: "Invoice 42", tables: [], pageCount: 2 }),
			SOURCE,
		)

		expect(result.text).toBe("Invoice 42")
		expect(result.tables).toEqual([])
		expect(result.fields).toEqual({})
		expect(result.metadata.provider).toBe("openai")
		expect(result.metadata.model).toBe("gpt-4o")
		expect(result.metadata.pageCount).toBe(2)
	})

	it("never claims a confidence, because a language model does not produce one", () => {
		const result = normalizeExtraction('{"text": "Invoice 42"}', SOURCE)

		expect(result.metadata.meanConfidence).toBeUndefined()
	})

	it("unwraps a ```json fence", () => {
		const result = normalizeExtraction('```json\n{"text": "Fenced"}\n```', SOURCE)

		expect(result.text).toBe("Fenced")
	})

	it("unwraps a bare fence with no language tag", () => {
		const result = normalizeExtraction('```\n{"text": "Fenced"}\n```', SOURCE)

		expect(result.text).toBe("Fenced")
	})

	it("ignores prose before and after the object", () => {
		const result = normalizeExtraction(
			'Here is what I read:\n{"text": "Receipt"}\nLet me know if you need more.',
			SOURCE,
		)

		expect(result.text).toBe("Receipt")
	})

	it("keeps a malformed reply as raw text rather than failing the extraction", () => {
		const reply = '{"text": "Invoice 42", "tables": ['
		const result = normalizeExtraction(reply, SOURCE)

		expect(result.text).toBe(reply)
		expect(result.tables).toEqual([])
		expect(result.fields).toEqual({})
		expect(result.metadata.provider).toBe("openai")
	})

	it("keeps a prose reply that is not JSON at all", () => {
		const result = normalizeExtraction("This image is too blurred to read.", SOURCE)

		expect(result.text).toBe("This image is too blurred to read.")
	})

	it("fills in every key the reply left out", () => {
		const result = normalizeExtraction('{"tables": []}', SOURCE)

		expect(result.text).toBe("")
		expect(result.tables).toEqual([])
		expect(result.fields).toEqual({})
		expect(result.metadata.pageCount).toBeUndefined()
	})

	it("survives wrong types and nulls where strings were asked for", () => {
		const result = normalizeExtraction(
			'{"text": 42, "tables": "not a list", "fields": null, "pageCount": "two"}',
			SOURCE,
		)

		expect(result.text).toBe("")
		expect(result.tables).toEqual([])
		expect(result.fields).toEqual({})
		expect(result.metadata.pageCount).toBeUndefined()
	})

	it("coerces non-string field values and drops the ones with no value", () => {
		const result = normalizeExtraction(
			JSON.stringify({
				fields: {
					total: 1234.5,
					paid: true,
					reference: "INV-42",
					lines: ["a", "b"],
					discount: null,
				},
			}),
			SOURCE,
		)

		expect(result.fields).toEqual({
			total: "1234.5",
			paid: "true",
			reference: "INV-42",
			lines: '["a","b"]',
		})
	})

	it("takes a table given as HTML", () => {
		const result = normalizeExtraction(
			JSON.stringify({ text: "", tables: [{ html: "<table><tr><td>A</td></tr></table>" }] }),
			SOURCE,
		)

		expect(result.tables).toEqual([{ html: "<table><tr><td>A</td></tr></table>" }])
	})

	it("takes a table given as bare HTML markup", () => {
		const result = normalizeExtraction(
			JSON.stringify({ tables: ["<table><tr><td>A</td></tr></table>"] }),
			SOURCE,
		)

		expect(result.tables).toEqual([{ html: "<table><tr><td>A</td></tr></table>" }])
	})

	it("builds markup for a table given only as rows", () => {
		const result = normalizeExtraction(
			JSON.stringify({ tables: [{ rows: [["Item", "Qty"], ["Bolt", 3]] }] }),
			SOURCE,
		)

		expect(result.tables).toEqual([
			{
				html: "<table><tr><td>Item</td><td>Qty</td></tr><tr><td>Bolt</td><td>3</td></tr></table>",
				rows: [
					["Item", "Qty"],
					["Bolt", "3"],
				],
			},
		])
	})

	it("builds markup for a table given as a bare array of rows", () => {
		const result = normalizeExtraction(JSON.stringify({ tables: [[["A", "B"]]] }), SOURCE)

		expect(result.tables).toEqual([
			{ html: "<table><tr><td>A</td><td>B</td></tr></table>", rows: [["A", "B"]] },
		])
	})

	it("escapes cell text when it builds markup from rows", () => {
		const result = normalizeExtraction(
			JSON.stringify({ tables: [{ rows: [["<b>&</b>"]] }] }),
			SOURCE,
		)

		expect(result.tables[0]?.html).toBe("<table><tr><td>&lt;b&gt;&amp;&lt;/b&gt;</td></tr></table>")
	})

	it("keeps both forms when the model sends markup and rows together", () => {
		const result = normalizeExtraction(
			JSON.stringify({ tables: [{ html: "<table></table>", rows: [["A"]] }] }),
			SOURCE,
		)

		expect(result.tables).toEqual([{ html: "<table></table>", rows: [["A"]] }])
	})

	it("drops a table entry that carries neither markup nor rows", () => {
		const result = normalizeExtraction(
			JSON.stringify({ tables: [{ caption: "Prices" }, null, { html: "   " }] }),
			SOURCE,
		)

		expect(result.tables).toEqual([])
	})

	it("returns an empty extraction for an empty reply", () => {
		const result = normalizeExtraction("", SOURCE)

		expect(result).toEqual({
			text: "",
			tables: [],
			fields: {},
			metadata: { provider: "openai", model: "gpt-4o" },
		})
	})

	it("records the provider even when no model is named", () => {
		const result = normalizeExtraction('{"text": "x"}', { provider: "paddle-ocr" })

		expect(result.metadata.provider).toBe("paddle-ocr")
		expect(result.metadata.model).toBeUndefined()
	})
})

describe("normalizeFieldsReply", () => {
	it("reads the wrapped shape the prompt asks for", () => {
		expect(normalizeFieldsReply('{"fields": {"total": "12.00"}}')).toEqual({ total: "12.00" })
	})

	it("reads a bare object, which is the other half of what models answer", () => {
		expect(normalizeFieldsReply('```json\n{"total": 12}\n```')).toEqual({ total: "12" })
	})

	it("gives nothing back for a reply that is not JSON", () => {
		expect(normalizeFieldsReply("There are no labelled values here.")).toEqual({})
	})

	it("gives nothing back for an empty reply", () => {
		expect(normalizeFieldsReply("")).toEqual({})
	})
})
