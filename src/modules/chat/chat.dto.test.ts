import { describe, expect, it } from "vitest"

import { sendMessageSchema } from "./chat.dto"

/**
 * The rule this file exists for is the one that is easy to get backwards:
 * a message may be text, or images, or both — and never neither.
 *
 * Relaxing `content` to allow an empty string is what makes an uncaptioned
 * image work, and it is also what would let an entirely empty turn through if
 * the refine were ever dropped. A turn with nothing in it still reaches a
 * provider, still costs money, and produces nothing anybody asked for.
 */
describe("sendMessageSchema", () => {
	it("accepts text on its own", () => {
		const parsed = sendMessageSchema.parse({ content: "What is our refund policy?" })
		expect(parsed.content).toBe("What is our refund policy?")
		expect(parsed.attachmentIds).toBeUndefined()
	})

	it("accepts attachments with no caption, and defaults the text to empty", () => {
		const parsed = sendMessageSchema.parse({ attachmentIds: ["att_1"] })
		expect(parsed.content).toBe("")
		expect(parsed.attachmentIds).toEqual(["att_1"])
	})

	it("accepts text and attachments together", () => {
		const parsed = sendMessageSchema.parse({
			content: "What is the total?",
			attachmentIds: ["att_1", "att_2"],
		})
		expect(parsed.content).toBe("What is the total?")
		expect(parsed.attachmentIds).toHaveLength(2)
	})

	it("refuses a message with neither text nor attachments", () => {
		expect(sendMessageSchema.safeParse({}).success).toBe(false)
		expect(sendMessageSchema.safeParse({ content: "" }).success).toBe(false)
		expect(sendMessageSchema.safeParse({ content: "   " }).success).toBe(false)
		expect(sendMessageSchema.safeParse({ content: "", attachmentIds: [] }).success).toBe(false)
	})

	it("refuses more attachments than a composer can hold", () => {
		const ids = Array.from({ length: 7 }, (_, index) => `att_${index}`)
		expect(sendMessageSchema.safeParse({ content: "look", attachmentIds: ids }).success).toBe(
			false,
		)
		expect(
			sendMessageSchema.safeParse({ content: "look", attachmentIds: ids.slice(0, 6) }).success,
		).toBe(true)
	})

	it("keeps the other per-turn overrides working", () => {
		const parsed = sendMessageSchema.parse({
			content: "narrow this",
			topK: 5,
			searchMode: "keyword",
			documentIds: ["doc_1"],
		})
		expect(parsed.topK).toBe(5)
		expect(parsed.searchMode).toBe("keyword")
		expect(parsed.documentIds).toEqual(["doc_1"])
	})
})
