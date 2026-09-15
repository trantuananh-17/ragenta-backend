import { z } from "zod"

/**
 * What the model is told about the connections it may call.
 *
 * Pure and separate for the reason every other `*-content.ts` here is: the tool
 * itself reaches the repository, and this part has to be provable without one.
 */

/** The slice of a connection the model is allowed to know about. Never the secret. */
export interface ApiCallConnection {
	name: string
	description: string | null
	allowedMethods: string[]
	allowedPathPrefix: string
}

export function apiCallParameters(connections: ApiCallConnection[]) {
	const names = connections.map((connection) => connection.name)
	return z.object({
		integration: z
			.string()
			.trim()
			.min(1)
			.describe(
				names.length > 0
					? `Which connection to call. One of: ${names.join(", ")}.`
					: "Which configured connection to call, by its name.",
			),
		method: z
			.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
			.default("GET")
			.describe("HTTP method. The connection decides which are allowed."),
		path: z
			.string()
			.max(1_000)
			.default("/")
			.describe(
				"Path and query on that connection's base URL, e.g. /v1/contacts?limit=10. Write {{visitor.id}} or {{visitor.email}} where the current visitor's identity belongs; it is filled in for you.",
			),
		body: z.string().max(8_000).optional().describe("JSON body, for POST, PUT and PATCH."),
	})
}

/**
 * The catalogue the model reads, in plain language, so the person configuring
 * the agent describes what a connection is *for* and never has to write
 * "call api_call with integration shop" into a brief.
 */
export function describeApiCall(connections: ApiCallConnection[]): string {
	const listed = connections.map((connection) => {
		const limits = `Allows ${connection.allowedMethods.join(", ")}${
			connection.allowedPathPrefix ? ` under ${connection.allowedPathPrefix}` : ""
		}.`
		const purpose = connection.description?.trim()
		return `- "${connection.name}": ${purpose ? `${purpose} ` : ""}${limits} Write {{visitor.id}} where the current visitor's id belongs.`
	})

	return [
		"Call one of the systems connected to this workspace. Use it whenever the visitor's question needs live data from one of them.",
		"",
		"Connections available:",
		listed.join("\n") || "(none — this workspace has no connections)",
		"",
		"Each connection limits which methods and paths you may use; a call outside those is refused.",
	].join("\n")
}
