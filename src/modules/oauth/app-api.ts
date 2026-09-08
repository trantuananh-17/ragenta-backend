import { ValidationError } from "../../shared/errors"
import { oauthRepository } from "./oauth.repository"
import { oauthService } from "./oauth.service"

/**
 * Calling any connected app as the account a workspace connected.
 *
 * The generalisation of `google-api.ts`, written once the second provider needed
 * it rather than guessed at when the first one did. What differs between
 * providers is the base URL, the extra headers and how each reports an error in
 * a 200 — and that last one is the whole reason this exists rather than six
 * copies of `fetch` (ADR-061).
 *
 * Plain `fetch`, not `safeFetch`: the hosts are constants here, not anything a
 * customer typed.
 */

const TIMEOUT_MS = 20_000

export interface AppCall {
	provider: string
	url: string
	method?: "GET" | "POST" | "PATCH" | "PUT"
	body?: unknown
	headers?: Record<string, string>
	/**
	 * Some providers answer 200 with `{ ok: false, error: "..." }` — Slack does,
	 * and treating that as success is how a message nobody received gets reported
	 * as sent. Given here so each provider's convention lives beside its tools.
	 */
	readErrorFrom?: (payload: Record<string, unknown>) => string | undefined
}

export class NoConnectionError extends ValidationError {
	constructor(provider: string) {
		super(
			`No ${provider} account is connected to this workspace. Connect one in Settings before using this tool.`,
		)
	}
}

export async function callConnectedApp(
	workspaceId: string,
	call: AppCall,
): Promise<Record<string, unknown>> {
	const connection = await oauthRepository.findActive(workspaceId, call.provider)
	if (!connection) throw new NoConnectionError(call.provider)

	const token = await oauthService.accessTokenFor(workspaceId, connection.id)

	const response = await fetch(call.url, {
		method: call.method ?? "GET",
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/json",
			...(call.body === undefined ? {} : { "content-type": "application/json" }),
			...call.headers,
		},
		body: call.body === undefined ? undefined : JSON.stringify(call.body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	})

	const text = await response.text()
	let payload: Record<string, unknown> = {}
	if (text.length > 0) {
		try {
			payload = JSON.parse(text) as Record<string, unknown>
		} catch {
			throw new ValidationError(`${call.provider} answered with something that was not JSON.`)
		}
	}

	if (!response.ok) {
		const reason =
			typeof payload.message === "string"
				? payload.message
				: typeof payload.error === "string"
					? payload.error
					: `HTTP ${response.status}`
		throw new ValidationError(`${call.provider} refused the request: ${reason}`)
	}

	// The 200-with-an-error case, per provider.
	const softError = call.readErrorFrom?.(payload)
	if (softError) {
		throw new ValidationError(`${call.provider} refused the request: ${softError}`)
	}

	return payload
}
