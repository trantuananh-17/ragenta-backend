import { env } from "../../config/env"
import type { AppContext } from "../../api/types"
import { requireMembership, requireParam, requireUser } from "../../api/types"
import { oauthCallbackSchema, saveOAuthClientSchema, startOAuthSchema } from "./oauth.dto"
import { oauthService } from "./oauth.service"

export const oauthController = {
	async listProviders(c: AppContext) {
		return c.json({ providers: await oauthService.listProviders() })
	},

	async list(c: AppContext) {
		const membership = requireMembership(c)
		return c.json({ connections: await oauthService.list(membership.organizationId) })
	},

	async start(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		const { returnTo } = startOAuthSchema.parse(await c.req.json().catch(() => ({})))
		const started = await oauthService.start(
			membership.organizationId,
			requireParam(c, "provider"),
			user.id,
			returnTo,
		)
		// The URL is returned rather than redirected to: the caller is this app's
		// own fetch, and a 302 on an XHR is followed by the browser into a page it
		// cannot render.
		return c.json(started)
	},

	/**
	 * The provider sends the browser here.
	 *
	 * A **redirect** rather than JSON, because a person is looking at it. Both
	 * outcomes land on the app: a failure carries a message in the query string
	 * rather than showing the provider's own error page, which says nothing about
	 * Ragenta and offers no way back.
	 */
	async callback(c: AppContext) {
		const user = requireUser(c)
		const query = oauthCallbackSchema.parse(c.req.query())
		const provider = requireParam(c, "provider")

		if (query.error || !query.code || !query.state) {
			const reason = query.error_description ?? query.error ?? "The authorization was cancelled."
			return c.redirect(
				`${env.appBaseUrl}/settings/connections?error=${encodeURIComponent(reason)}`,
			)
		}

		try {
			const done = await oauthService.complete(provider, query.code, query.state, user.id)
			return c.redirect(
				`${env.appBaseUrl}${done.returnTo}?connected=${encodeURIComponent(done.provider)}`,
			)
		} catch (error) {
			const reason = error instanceof Error ? error.message : "The connection failed."
			return c.redirect(
				`${env.appBaseUrl}/settings/connections?error=${encodeURIComponent(reason)}`,
			)
		}
	},

	async disconnect(c: AppContext) {
		const user = requireUser(c)
		const membership = requireMembership(c)
		await oauthService.disconnect(
			membership.organizationId,
			requireParam(c, "connectionId"),
			user.id,
		)
		return c.body(null, 204)
	},

	/** The console's own list, with the redirect URI to register at each provider. */
	async listForAdmin(c: AppContext) {
		return c.json({ providers: forAdmin(await oauthService.listProviders()) })
	},

	async saveClient(c: AppContext) {
		const user = requireUser(c)
		const input = saveOAuthClientSchema.parse(await c.req.json())
		const providers = await oauthService.saveClient(requireParam(c, "provider"), input, user.id)
		return c.json({ providers: forAdmin(providers) })
	},
}

/**
 * A provider as the console reads it: the list, plus the redirect URI.
 *
 * Both endpoints answer with this shape. They diverged once — a save replied
 * without `redirectUri`, the console parses every reply with one schema, and a
 * save that had already been written reported "Could not save".
 */
function forAdmin(providers: Awaited<ReturnType<typeof oauthService.listProviders>>) {
	return providers.map((provider) => ({
		...provider,
		redirectUri: oauthService.redirectUriFor(provider.id),
	}))
}
