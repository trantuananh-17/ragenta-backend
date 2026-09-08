import { env } from "../../config/env"
import { decryptSecret, encryptSecret, maskSecret } from "../../shared/crypto"
import { NotFoundError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import { getRedis } from "../../redis/client"
import { auditService } from "../audit/audit.service"
import { providerRepository } from "../provider/provider.repository"
import { oauthRepository } from "./oauth.repository"
import type { OAuthConnectionRow } from "./oauth.repository"
import { createPkcePair, createState, safeReturnTo, stateBelongsTo } from "./pkce"
import type { OAuthState } from "./pkce"
import {
	OAUTH_CLIENTS_SETTING,
	OAUTH_PROVIDERS,
	findOAuthProvider,
	oauthCredentialId,
} from "./providers"
import type { SaveOAuthClientInput } from "./oauth.dto"
import type { OAuthClientSettings, OAuthProvider } from "./providers"

const log = logger.child({ module: "oauth" })

/**
 * How long an authorization may take. Ten minutes is generous for somebody
 * signing in and choosing an account, and short enough that a state parameter
 * leaked into a log or a referrer is worthless by the time anybody reads it.
 */
const STATE_TTL_SECONDS = 600

/** Refreshed this far before expiry, so a call in flight does not race the clock. */
const REFRESH_MARGIN_MS = 120_000

const DEFAULT_RETURN_TO = "/settings/connections"

function stateKey(state: string): string {
	return `oauth:state:${state}`
}

function refreshLockKey(connectionId: string): string {
	return `oauth:refresh:${connectionId}`
}

/** Where the provider sends the browser back. Fixed by configuration, never by a request. */
function redirectUri(providerId: string): string {
	return `${env.apiBaseUrl}/v1/oauth/${providerId}/callback`
}

interface ResolvedClient {
	clientId: string
	clientSecret: string
}

/**
 * The deployment's own OAuth app for this provider.
 *
 * The non-secret half lives in `platform_setting` and the secret in
 * `provider_credential` under a reserved id — the split ADR-043 established for
 * speech, reused rather than reinvented. Two places a secret can live is one
 * place nobody audits.
 */
async function resolveClient(provider: OAuthProvider): Promise<ResolvedClient> {
	const settings = await readClientSettings()
	const entry = settings[provider.id]

	if (!entry?.enabled || !entry.clientId) {
		throw new ValidationError(
			`${provider.name} is not configured on this deployment. An administrator has to register an OAuth app for it first.`,
		)
	}

	const credential = await providerRepository.findCredential(oauthCredentialId(provider.id))
	if (!credential) {
		throw new ValidationError(
			`${provider.name} has a client id but no client secret stored. Both are needed.`,
		)
	}

	return { clientId: entry.clientId, clientSecret: decryptSecret(credential.encryptedKey) }
}

export const oauthService = {
	/** The providers this build knows, with whether the deployment has configured each. */
	async listProviders() {
		const settings = await readClientSettings()

		return OAUTH_PROVIDERS.map((provider) => ({
			id: provider.id,
			name: provider.name,
			scopes: provider.scopes,
			configured: settings[provider.id]?.enabled === true && Boolean(settings[provider.id]?.clientId),
		}))
	},

	async list(workspaceId: string) {
		return (await oauthRepository.list(workspaceId)).map(toPublic)
	},

	/**
	 * Starts an authorization.
	 *
	 * The verifier and the state live in Redis for ten minutes, keyed by the
	 * state, and carry the workspace and the person who started it. Both are
	 * checked at the callback: the provider match stops a code being redeemed
	 * elsewhere, and the **user** match is what makes a stolen state parameter
	 * useless (`pkce.ts`).
	 */
	async start(
		workspaceId: string,
		providerId: string,
		userId: string,
		returnTo: string | undefined,
	) {
		const provider = findOAuthProvider(providerId)
		if (!provider) throw new NotFoundError("Provider")

		const client = await resolveClient(provider)
		const pkce = createPkcePair()
		const state = createState()

		const stored: OAuthState = {
			state,
			verifier: pkce.verifier,
			workspaceId,
			userId,
			provider: provider.id,
			returnTo: safeReturnTo(returnTo, DEFAULT_RETURN_TO),
		}

		await getRedis().set(stateKey(state), JSON.stringify(stored), "EX", STATE_TTL_SECONDS)

		const url = new URL(provider.authorizeUrl)
		url.searchParams.set("response_type", "code")
		url.searchParams.set("client_id", client.clientId)
		url.searchParams.set("redirect_uri", redirectUri(provider.id))
		url.searchParams.set("state", state)
		url.searchParams.set("code_challenge", pkce.challenge)
		url.searchParams.set("code_challenge_method", pkce.method)
		if (provider.scopes.length > 0) {
			url.searchParams.set("scope", provider.scopes.join(" "))
		}
		for (const [key, value] of Object.entries(provider.extraAuthorizeParams ?? {})) {
			url.searchParams.set(key, value)
		}

		return { authorizeUrl: url.toString() }
	},

	/**
	 * Completes an authorization.
	 *
	 * The state is deleted before anything else happens, so a replayed callback
	 * finds nothing — an authorization code is single-use at the provider too, but
	 * relying on that is relying on somebody else's implementation.
	 */
	async complete(providerId: string, code: string, state: string, userId: string) {
		const provider = findOAuthProvider(providerId)
		if (!provider) throw new NotFoundError("Provider")

		const raw = await getRedis().getdel(stateKey(state))
		if (!raw) {
			throw new ValidationError(
				"That authorization has expired or was already used. Start it again.",
			)
		}

		const stored = JSON.parse(raw) as OAuthState
		if (!stateBelongsTo(stored, provider.id, userId)) {
			// Deliberately the same message: distinguishing "not your authorization"
			// from "wrong provider" tells somebody probing which half they got right.
			log.warn("oauth.state_mismatch", { provider: provider.id })
			throw new ValidationError("That authorization could not be completed. Start it again.")
		}

		const client = await resolveClient(provider)
		const token = await exchange(provider, client, {
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri(provider.id),
			code_verifier: stored.verifier,
		})

		const profile = await fetchProfile(provider, token.accessToken)

		await oauthRepository.upsert({
			id: newId(),
			organizationId: stored.workspaceId,
			provider: provider.id,
			accountLabel: profile.label,
			externalAccountId: profile.id,
			scopes: token.scopes,
			encryptedAccessToken: encryptSecret(token.accessToken),
			encryptedRefreshToken: token.refreshToken ? encryptSecret(token.refreshToken) : null,
			expiresAt: token.expiresAt,
			status: "active",
			createdBy: stored.userId,
		})

		await auditService.record({
			action: "oauth.connected",
			actorId: stored.userId,
			organizationId: stored.workspaceId,
			targetType: "oauth_connection",
			targetId: profile.id,
			metadata: { provider: provider.id, account: profile.label, scopes: token.scopes },
		})

		log.info("oauth.connected", { provider: provider.id, workspace: stored.workspaceId })
		return { returnTo: stored.returnTo, provider: provider.id, account: profile.label }
	},

	/**
	 * A usable access token for this connection, refreshing it if it is about to
	 * expire.
	 *
	 * **Single-flight.** Two tool calls in one run reach here at the same moment,
	 * and a provider that rotates its refresh token invalidates the old one the
	 * instant it issues a new one — so two concurrent refreshes leave one of them
	 * holding a token that is already dead, and the connection breaks for reasons
	 * nobody can reconstruct. The loser of the lock waits and re-reads.
	 */
	async accessTokenFor(workspaceId: string, connectionId: string): Promise<string> {
		const connection = await oauthRepository.findById(workspaceId, connectionId)
		if (!connection) throw new NotFoundError("Connection")
		if (connection.status !== "active") {
			throw new ValidationError(
				`This ${connection.provider} connection is ${connection.status}. Reconnect it.`,
			)
		}

		if (!needsRefresh(connection)) return decryptSecret(connection.encryptedAccessToken)

		const redis = getRedis()
		const got = await redis.set(refreshLockKey(connection.id), "1", "EX", 30, "NX")

		if (!got) {
			// Somebody else is refreshing. Wait one short beat and re-read rather
			// than refreshing in parallel.
			await new Promise((resolve) => setTimeout(resolve, 750))
			const fresh = await oauthRepository.findById(workspaceId, connectionId)
			if (fresh && !needsRefresh(fresh)) return decryptSecret(fresh.encryptedAccessToken)
		}

		try {
			return await oauthService.refresh(connection)
		} finally {
			await redis.del(refreshLockKey(connection.id)).catch(() => undefined)
		}
	},

	async refresh(connection: OAuthConnectionRow): Promise<string> {
		const provider = findOAuthProvider(connection.provider)
		if (!provider) throw new NotFoundError("Provider")

		if (!connection.encryptedRefreshToken) {
			await oauthRepository.update(connection.id, {
				status: "expired",
				lastError: "The provider issued no refresh token, so this connection cannot be renewed.",
			})
			throw new ValidationError(
				`This ${provider.name} connection cannot be renewed and has to be reconnected.`,
			)
		}

		const client = await resolveClient(provider)

		try {
			const token = await exchange(provider, client, {
				grant_type: "refresh_token",
				refresh_token: decryptSecret(connection.encryptedRefreshToken),
			})

			await oauthRepository.update(connection.id, {
				encryptedAccessToken: encryptSecret(token.accessToken),
				// Only when a new one came back. A provider that does not rotate sends
				// nothing here, and overwriting with null would destroy the only means
				// of ever renewing this connection again.
				...(token.refreshToken
					? { encryptedRefreshToken: encryptSecret(token.refreshToken) }
					: {}),
				expiresAt: token.expiresAt,
				lastRefreshedAt: new Date(),
				status: "active",
				lastError: null,
			})

			return token.accessToken
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			// A refusal here usually means somebody revoked access at the other end.
			// Recording it as `revoked` is what lets a screen say "reconnect" rather
			// than showing a connection that looks fine and fails on every use.
			await oauthRepository.update(connection.id, {
				status: "revoked",
				lastError: message.slice(0, 500),
			})
			log.warn("oauth.refresh_failed", { provider: provider.id, error: message })
			throw new ValidationError(
				`This ${provider.name} connection is no longer accepted. Reconnect it.`,
			)
		}
	},

	/**
	 * Registers the deployment's OAuth app for a provider.
	 *
	 * The client id is not a secret and goes in `platform_setting`; the secret goes
	 * in `provider_credential` under a reserved id. That split is ADR-043's, reused
	 * rather than reinvented — a second place a secret can live is the one nobody
	 * audits.
	 */
	async saveClient(providerId: string, input: SaveOAuthClientInput, actorId: string) {
		const provider = findOAuthProvider(providerId)
		if (!provider) throw new NotFoundError("Provider")

		const settings = await readClientSettings()
		settings[provider.id] = { clientId: input.clientId, enabled: input.enabled }
		await providerRepository.upsertSetting(OAUTH_CLIENTS_SETTING, settings, actorId)

		if (input.clientSecret) {
			await providerRepository.upsertCredential({
				provider: oauthCredentialId(provider.id),
				encryptedKey: encryptSecret(input.clientSecret),
				keyHint: maskSecret(input.clientSecret),
				updatedBy: actorId,
			})
		}

		await auditService.record({
			action: "oauth.client.saved",
			actorId,
			targetType: "oauth_provider",
			targetId: provider.id,
			metadata: { enabled: input.enabled, secretChanged: Boolean(input.clientSecret) },
		})

		return oauthService.listProviders()
	},

	/** The redirect URI to register with the provider. Fixed, and worth showing. */
	redirectUriFor(providerId: string): string {
		return redirectUri(providerId)
	},

	async disconnect(workspaceId: string, connectionId: string, actorId: string) {
		const removed = await oauthRepository.remove(workspaceId, connectionId)
		if (!removed) throw new NotFoundError("Connection")

		await auditService.record({
			action: "oauth.disconnected",
			actorId,
			organizationId: workspaceId,
			targetType: "oauth_connection",
			targetId: connectionId,
			metadata: { provider: removed.provider, account: removed.accountLabel },
		})
	},
}

/** The non-secret half of every provider's OAuth app, as one settings row. */
async function readClientSettings(): Promise<OAuthClientSettings> {
	const row = await providerRepository.findSetting(OAUTH_CLIENTS_SETTING)
	const value = row?.value
	return value && typeof value === "object" ? (value as OAuthClientSettings) : {}
}

function needsRefresh(connection: OAuthConnectionRow): boolean {
	if (!connection.expiresAt) return false
	return connection.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS
}

interface TokenResponse {
	accessToken: string
	refreshToken?: string
	expiresAt: Date | null
	scopes: string[]
}

/**
 * The token endpoint, for both grants.
 *
 * Plain `fetch`, not `safeFetch`: the URL is a constant in the provider registry
 * rather than anything a customer typed, so there is no SSRF surface — and
 * `safeFetch` blocks private addresses, which would be wrong for a provider that
 * a self-hosted deployment might legitimately reach on its own network.
 *
 * The client secret goes in the body rather than in a Basic header because it is
 * the form every provider here accepts; sending both would send the secret twice.
 */
async function exchange(
	provider: OAuthProvider,
	client: ResolvedClient,
	params: Record<string, string>,
): Promise<TokenResponse> {
	const body = new URLSearchParams({
		...params,
		client_id: client.clientId,
		client_secret: client.clientSecret,
	})

	const response = await fetch(provider.tokenUrl, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body,
		signal: AbortSignal.timeout(20_000),
	})

	const text = await response.text()
	let payload: Record<string, unknown>
	try {
		payload = JSON.parse(text) as Record<string, unknown>
	} catch {
		throw new ValidationError(`${provider.name} did not answer the token request with JSON.`)
	}

	if (!response.ok || typeof payload.access_token !== "string") {
		// The provider's own error, which is what makes a misconfigured client id
		// diagnosable. It describes the request, never the secret.
		const reason =
			typeof payload.error_description === "string"
				? payload.error_description
				: typeof payload.error === "string"
					? payload.error
					: `HTTP ${response.status}`
		throw new ValidationError(`${provider.name} refused the token request: ${reason}`)
	}

	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined

	return {
		accessToken: payload.access_token,
		refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
		expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1_000) : null,
		// What was actually granted, which is not always what was asked for — a
		// user can uncheck a scope on Google's consent screen.
		scopes: typeof payload.scope === "string" ? payload.scope.split(/[\s,]+/).filter(Boolean) : [],
	}
}

/** Who this connection is on the far side, so a screen can name the account. */
async function fetchProfile(
	provider: OAuthProvider,
	accessToken: string,
): Promise<{ id: string; label: string }> {
	const response = await fetch(provider.profileUrl, {
		headers: {
			authorization: `Bearer ${accessToken}`,
			accept: "application/json",
			// Notion refuses without it, and sending it to the others is harmless.
			"notion-version": "2022-06-28",
		},
		signal: AbortSignal.timeout(20_000),
	})

	if (!response.ok) {
		throw new ValidationError(
			`${provider.name} accepted the authorization but refused to say which account it was for.`,
		)
	}

	const payload = (await response.json()) as Record<string, unknown>
	const id = payload[provider.profileIdField]
	const label = payload[provider.profileLabelField]

	return {
		id: id === undefined || id === null ? "" : String(id),
		// A connection with no readable name is still usable; naming it after the
		// provider beats refusing an authorization that otherwise worked.
		label: typeof label === "string" && label.length > 0 ? label : provider.name,
	}
}

/** The row as an API response. Never a token, and there is no masked hint to show. */
function toPublic(row: OAuthConnectionRow) {
	return {
		id: row.id,
		provider: row.provider,
		accountLabel: row.accountLabel,
		scopes: row.scopes,
		status: row.status,
		expiresAt: row.expiresAt,
		lastRefreshedAt: row.lastRefreshedAt,
		lastError: row.lastError,
		createdAt: row.createdAt,
		/** Told plainly, because it decides whether this connection survives an hour. */
		renewable: row.encryptedRefreshToken !== null,
	}
}
