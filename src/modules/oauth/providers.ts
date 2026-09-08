/**
 * The OAuth providers this build can connect to.
 *
 * Compiled in, like the tool registry and unlike the permission catalogue: a
 * provider is not something an administrator composes, it is an integration
 * somebody wrote code for. What *is* configuration is the client id and secret,
 * because those are per-deployment — Ragenta registers its own OAuth app.
 *
 * One flow serves all of them. Every provider below is authorization-code with
 * PKCE, which is what makes "add Slack" a table entry rather than a second
 * implementation of the thing most likely to be got wrong (ADR-059).
 */

export interface OAuthProvider {
	id: string
	name: string
	authorizeUrl: string
	tokenUrl: string
	/** Where the account's own name comes from, so a screen can say which one. */
	profileUrl: string
	/** Read out of the profile response. */
	profileIdField: string
	profileLabelField: string
	/** What is asked for. A provider may grant less, which is recorded. */
	scopes: string[]
	/**
	 * Parameters some providers need to issue a refresh token at all.
	 *
	 * Google is the reason this exists: without `access_type=offline` it returns
	 * an access token and nothing to renew it with, and without `prompt=consent`
	 * it silently omits the refresh token on every authorization after the first
	 * — so a reconnect produces a connection that works for an hour and then
	 * cannot be renewed, with nothing on any screen to explain it.
	 */
	extraAuthorizeParams?: Record<string, string>
	/** True when the provider rotates the refresh token on every use. */
	rotatesRefreshToken?: boolean
}

export const OAUTH_PROVIDERS: OAuthProvider[] = [
	{
		id: "google",
		name: "Google",
		authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		profileUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
		profileIdField: "id",
		profileLabelField: "email",
		scopes: [
			"openid",
			"email",
			"https://www.googleapis.com/auth/gmail.readonly",
			"https://www.googleapis.com/auth/gmail.send",
			"https://www.googleapis.com/auth/drive.readonly",
			"https://www.googleapis.com/auth/calendar.readonly",
			"https://www.googleapis.com/auth/spreadsheets",
		],
		extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
	},
	{
		id: "slack",
		name: "Slack",
		authorizeUrl: "https://slack.com/oauth/v2/authorize",
		tokenUrl: "https://slack.com/api/oauth.v2.access",
		profileUrl: "https://slack.com/api/auth.test",
		profileIdField: "user_id",
		profileLabelField: "team",
		scopes: ["chat:write", "channels:read", "channels:history", "users:read"],
	},
	{
		id: "github",
		name: "GitHub",
		authorizeUrl: "https://github.com/login/oauth/authorize",
		tokenUrl: "https://github.com/login/oauth/access_token",
		profileUrl: "https://api.github.com/user",
		profileIdField: "id",
		profileLabelField: "login",
		scopes: ["repo", "read:org"],
	},
	{
		id: "notion",
		name: "Notion",
		authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
		tokenUrl: "https://api.notion.com/v1/oauth/token",
		profileUrl: "https://api.notion.com/v1/users/me",
		profileIdField: "id",
		profileLabelField: "name",
		scopes: [],
	},
]

export function findOAuthProvider(id: string): OAuthProvider | undefined {
	return OAUTH_PROVIDERS.find((provider) => provider.id === id)
}

/** The id a provider's client secret is stored under in `provider_credential`. */
export function oauthCredentialId(providerId: string): string {
	return `oauth:${providerId}`
}

/** The `platform_setting` row holding every provider's non-secret half. */
export const OAUTH_CLIENTS_SETTING = "oauth.clients"

export interface OAuthClientSettings {
	[providerId: string]: { clientId: string; enabled: boolean } | undefined
}
