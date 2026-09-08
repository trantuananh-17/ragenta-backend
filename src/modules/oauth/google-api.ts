import { ValidationError } from "../../shared/errors"
import { oauthRepository } from "./oauth.repository"
import { oauthService } from "./oauth.service"

/**
 * Calling Google as the account a workspace connected.
 *
 * One place that resolves the connection, refreshes the token if it is about to
 * expire and turns Google's own refusal into a sentence the model can act on.
 * Every Google tool goes through it, so "which account is this acting as" and
 * "what happens when the token died" have one answer rather than six (ADR-060).
 *
 * Plain `fetch` rather than `safeFetch`: the hosts are constants in this file,
 * not anything a customer typed, so there is no SSRF surface — and the address
 * checks would refuse nothing here anyway.
 */

const TIMEOUT_MS = 20_000

/**
 * Google's own scope strings, so a tool can say *which* permission is missing
 * rather than "insufficient permissions", which sends somebody to reconnect
 * without telling them what to tick.
 */
export const GOOGLE_SCOPES = {
	gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
	gmailSend: "https://www.googleapis.com/auth/gmail.send",
	driveRead: "https://www.googleapis.com/auth/drive.readonly",
	calendarRead: "https://www.googleapis.com/auth/calendar.readonly",
	sheets: "https://www.googleapis.com/auth/spreadsheets",
} as const

export interface GoogleCall {
	url: string
	method?: "GET" | "POST" | "PUT"
	body?: unknown
	/** The scope this call needs, checked before the request rather than after. */
	scope: string
}

export class NoGoogleConnectionError extends ValidationError {
	constructor() {
		super(
			"No Google account is connected to this workspace. Connect one in Settings before using this tool.",
		)
	}
}

/**
 * Makes one call as the workspace's Google account.
 *
 * The scope is checked here, before the request, because Google's own answer to
 * a missing scope is a 403 whose body says "Request had insufficient
 * authentication scopes" and names none of them — which is the least actionable
 * message in the product.
 */
export async function callGoogle(workspaceId: string, call: GoogleCall): Promise<unknown> {
	const connection = await oauthRepository.findActive(workspaceId, "google")
	if (!connection) throw new NoGoogleConnectionError()

	if (connection.scopes.length > 0 && !connection.scopes.includes(call.scope)) {
		throw new ValidationError(
			`The connected Google account (${connection.accountLabel}) did not grant "${call.scope}". Reconnect it and accept that permission.`,
		)
	}

	const token = await oauthService.accessTokenFor(workspaceId, connection.id)

	const response = await fetch(call.url, {
		method: call.method ?? "GET",
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/json",
			...(call.body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: call.body === undefined ? undefined : JSON.stringify(call.body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	})

	const text = await response.text()

	if (!response.ok) {
		// Google's own message, which is what makes a wrong spreadsheet id or a
		// deleted file diagnosable. It describes the request, never the token.
		let reason = `HTTP ${response.status}`
		try {
			const payload = JSON.parse(text) as { error?: { message?: string } }
			if (payload.error?.message) reason = payload.error.message
		} catch {
			// A non-JSON body means a proxy answered, not the API.
		}
		throw new ValidationError(`Google refused the request: ${reason}`)
	}

	if (text.length === 0) return {}

	try {
		return JSON.parse(text) as unknown
	} catch {
		throw new ValidationError("Google answered with something that was not JSON.")
	}
}

/** Which Google account a workspace is acting as, for a tool's own message. */
export async function connectedGoogleAccount(workspaceId: string): Promise<string | undefined> {
	const connection = await oauthRepository.findActive(workspaceId, "google")
	return connection?.accountLabel
}
