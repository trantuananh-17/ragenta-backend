import { z } from "zod"

import { WEBHOOK_EVENTS } from "./events"

const EVENT_KEYS = WEBHOOK_EVENTS.map((event) => event.key)

/**
 * `https` only, and not for symmetry with the MCP server rule that allows both.
 *
 * That one dials a server the deployment's operator chose, on a network they
 * control. This one posts a **signed payload about a customer's data** to a host
 * a customer typed, across the public internet. Over http the signature still
 * proves who sent it and does nothing at all to stop anybody on the path reading
 * the body.
 */
const urlSchema = z
	.string()
	.trim()
	.url()
	.max(500)
	.refine((value) => value.startsWith("https://"), "A webhook URL must be https.")

export const saveWebhookEndpointSchema = z.object({
	name: z.string().trim().min(1).max(120),
	url: urlSchema,
	enabled: z.boolean().default(true),
	/**
	 * Validated against the catalogue rather than accepted as free text. An
	 * endpoint subscribed to `agent.run.finished` — a plausible name we do not
	 * emit — would wait forever, and the customer would have no way to tell that
	 * from a broken delivery.
	 */
	events: z
		.array(z.enum(EVENT_KEYS as [string, ...string[]]))
		.min(1, "Choose at least one event — an endpoint with none is never called.")
		.max(WEBHOOK_EVENTS.length),
})

export type SaveWebhookEndpointInput = z.infer<typeof saveWebhookEndpointSchema>
