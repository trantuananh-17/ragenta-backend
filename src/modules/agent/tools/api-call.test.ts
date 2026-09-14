import { describe, expect, it } from "vitest"

import { fillVisitor } from "./api-call.tool"

const visitor = { id: "u_1", email: "a+b@x.io" }

describe("fillVisitor", () => {
	it("fills both placeholders and encodes for a path", () => {
		expect(fillVisitor("/u/{{visitor.id}}?e={{ visitor.email }}", visitor, encodeURIComponent)).toBe(
			"/u/u_1?e=a%2Bb%40x.io",
		)
	})

	it("leaves a template without placeholders alone, visitor or not", () => {
		expect(fillVisitor("/orders", undefined)).toBe("/orders")
	})

	it("refuses rather than blanking when the visitor or the field is missing", () => {
		expect(fillVisitor("{{visitor.id}}", undefined)).toBeUndefined()
		expect(fillVisitor("{{visitor.email}}", { id: "u_1" })).toBeUndefined()
	})
})
