/**
 * The events a workspace may subscribe to.
 *
 * **Only events that are actually emitted somewhere in this codebase.** A
 * catalogue that lists what we might one day send produces integrations that
 * wait forever for a call that no line of code makes, and the customer has no
 * way to tell that from a broken endpoint. Every key here has a `emit` call
 * behind it; when one loses its caller, it comes out of this list.
 */
export interface WebhookEventDefinition {
	key: string
	/** What happened, in the words somebody choosing a subscription reads. */
	summary: string
	/** The fields the payload's `data` carries, for the screen and the docs. */
	fields: readonly string[]
}

export const WEBHOOK_EVENTS = [
	{
		key: "agent.run.succeeded",
		summary: "An agent run finished and produced an answer",
		fields: ["runId", "agentId", "agentName", "trigger", "credits", "durationMs"],
	},
	{
		key: "agent.run.failed",
		summary: "An agent run stopped without an answer",
		fields: ["runId", "agentId", "agentName", "trigger", "credits", "error"],
	},
	{
		key: "document.ingested",
		summary: "A document finished indexing and is searchable",
		fields: ["documentId", "knowledgeBaseId", "name", "chunks"],
	},
	{
		key: "document.failed",
		summary: "A document could not be indexed",
		fields: ["documentId", "knowledgeBaseId", "name", "error"],
	},
] as const satisfies readonly WebhookEventDefinition[]

export type WebhookEventKey = (typeof WEBHOOK_EVENTS)[number]["key"]

const KEYS: ReadonlySet<string> = new Set(WEBHOOK_EVENTS.map((event) => event.key))

export function isWebhookEvent(key: string): key is WebhookEventKey {
	return KEYS.has(key)
}

/**
 * Whether an endpoint subscribed to this event.
 *
 * An empty subscription list matches **nothing**. It is the inverse of the MCP
 * tool allowlist and inverted on purpose: there, empty widens a permission;
 * here, empty would widen a subscription and start posting a customer's server
 * payloads it has never seen a schema for. Both defaults are the narrow one.
 */
export function subscribes(events: readonly string[], event: string): boolean {
	return events.includes(event)
}
