import { describe, expect, it } from "vitest"

import { apiCallParameters, describeApiCall } from "./api-call-content"

const shop = {
	name: "shop",
	description: "Look up a customer's orders and delivery status.",
	allowedMethods: ["GET"],
	allowedPathPrefix: "/v1",
}
const crm = { name: "crm", description: null, allowedMethods: ["GET", "POST"], allowedPathPrefix: "" }

describe("the api_call catalogue", () => {
	it("tells the model each connection's name, purpose and limits", () => {
		const description = describeApiCall([shop, crm])

		expect(description).toContain('"shop": Look up a customer\'s orders and delivery status. Allows GET under /v1.')
		expect(description).toContain('"crm": Allows GET, POST.')
		expect(description).toContain("{{visitor.id}}")
	})

	it("names the connections the integration argument accepts", () => {
		const shape = apiCallParameters([shop, crm]).shape
		expect(shape.integration.description).toBe("Which connection to call. One of: shop, crm.")
	})

	it("says so when there is nothing to call", () => {
		expect(describeApiCall([])).toContain("(none")
		expect(apiCallParameters([]).shape.integration.description).not.toContain("One of")
	})
})
