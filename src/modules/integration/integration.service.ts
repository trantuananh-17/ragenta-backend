import { encryptSecret, maskSecret } from "../../shared/crypto"
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors"
import { auditService } from "../audit/audit.service"
import { safeFetch } from "../agent/tools/safe-fetch"
import { requireIntegration } from "../agent/tools/integrations"
import {
	chooseConnection,
	composeConnectionId,
	connectionCandidateIds,
	presentConnection,
} from "./connection-scope"
import type { SaveIntegrationInput } from "./integration.dto"
import { integrationRepository } from "./integration.repository"

/**
 * One service for both owners.
 *
 * `organizationId` is `null` for the platform-wide connections an administrator
 * manages and a workspace id for a workspace's own. It is never optional and
 * never defaulted: the owner is what every query filters on, so making a caller
 * state it is what stops a workspace route reaching a platform row it should
 * only be able to read through resolution (`.claude/rules/security.md`).
 */
type Owner = string | null

/**
 * The stored primary key. A workspace's connections are namespaced by the
 * workspace so two tenants can both call theirs `crm`; a platform-wide one is
 * the name itself, exactly as it has always been.
 */
function rowId(organizationId: Owner, name: string): string {
	return organizationId ? composeConnectionId(organizationId, name) : name
}

export const integrationService = {
	/**
	 * A workspace sees the platform-wide connections alongside its own, each
	 * labelled with its scope, because those are exactly the ones its agents may
	 * name — a list that hid them would make `api_call` look unconfigurable. The
	 * admin list is the platform-wide rows only: an administrator has no business
	 * reading a tenant's credential metadata out of a global list.
	 *
	 * Seeing is not changing. Everything below refuses a row this owner does not
	 * own, so a platform-wide connection appearing here is read-only to a
	 * workspace.
	 */
	async list(organizationId: Owner) {
		const owned = await integrationRepository.listOwnedBy(organizationId)
		if (organizationId === null) return owned.map(presentConnection)

		const platform = await integrationRepository.listOwnedBy(null)
		return [...owned, ...platform].map(presentConnection)
	},

	/**
	 * Resolved the same way a run resolves a connection, so what the screen shows
	 * is what the agent will actually get — including a workspace connection
	 * shadowing a platform-wide one of the same name.
	 */
	async get(organizationId: Owner, name: string) {
		const workspaceId = organizationId ?? undefined
		const rows = await integrationRepository.listResolvable(
			connectionCandidateIds(name, workspaceId),
			workspaceId,
		)
		const row = chooseConnection(rows, name, workspaceId)
		if (!row) throw new NotFoundError("Integration")
		return presentConnection(row)
	},

	/**
	 * Creates or replaces one connection.
	 *
	 * An omitted `secret` keeps whatever is stored: nobody can read the key back,
	 * so requiring it on every save would make every allowlist edit a key
	 * rotation.
	 */
	async save(
		organizationId: Owner,
		name: string,
		input: SaveIntegrationInput,
		actorId: string,
	) {
		if (input.kind === "http_api" && !input.baseUrl) {
			throw new ValidationError("An API connection needs a base URL.")
		}
		if (input.kind === "email" && input.allowedRecipients.length === 0) {
			throw new ValidationError(
				"An email connection needs at least one allowed recipient. Without one it would refuse every send.",
			)
		}
		// `web_search` resolves the deployment's own connection and takes no
		// workspace, so a workspace-owned one would be configuration that quietly
		// does nothing. Refused rather than stored until that tool is scoped too.
		if (organizationId !== null && input.kind === "web_search") {
			throw new ValidationError(
				"Web search uses the connection a platform administrator configured. A workspace cannot bring its own yet.",
			)
		}

		const id = rowId(organizationId, name)
		const owner = await integrationRepository.findOwner(id)
		if (owner && owner.organizationId !== organizationId) {
			throw new ConflictError("That connection id is already in use.")
		}

		const secretFields = input.secret
			? { encryptedSecret: encryptSecret(input.secret), secretHint: maskSecret(input.secret) }
			: {}

		const values = {
			id,
			organizationId,
			kind: input.kind,
			name: input.name,
			description: input.description,
			enabled: input.enabled,
			baseUrl: input.baseUrl,
			authHeader: input.authHeader,
			authPrefix: input.authPrefix,
			allowedMethods: input.allowedMethods,
			allowedPathPrefix: input.allowedPathPrefix,
			allowedRecipients: input.allowedRecipients,
			updatedBy: actorId,
			...secretFields,
		}

		const saved = owner
			? await integrationRepository.update(id, organizationId, values)
			: await integrationRepository.insert(values)
		if (!saved) throw new NotFoundError("Integration")

		// The key is not in the metadata, and must never be: an audit trail is
		// read by more people than the table it describes.
		await auditService.record({
			action: owner ? "integration.updated" : "integration.created",
			actorId,
			organizationId,
			targetType: "integration",
			targetId: id,
			metadata: {
				kind: input.kind,
				secretRotated: Boolean(input.secret),
				allowedMethods: input.allowedMethods,
			},
		})

		return presentConnection(saved)
	},

	async remove(organizationId: Owner, name: string, actorId: string) {
		const id = rowId(organizationId, name)
		const deleted = await integrationRepository.remove(id, organizationId)
		if (!deleted) throw new NotFoundError("Integration")

		await auditService.record({
			action: "integration.deleted",
			actorId,
			organizationId,
			targetType: "integration",
			targetId: id,
		})
	},

	/**
	 * One cheap live call proving the connection works, and the outcome recorded
	 * on the row — the same affordance the models screen has, for the same
	 * reason: whoever configured a key should not have to run an agent to find
	 * out that it is wrong.
	 */
	async check(organizationId: Owner, name: string) {
		// Deliberately the owned row rather than the resolved one: a check spends a
		// real call and writes its outcome onto the row, and a platform-wide
		// connection's key is the platform administrator's to test.
		const existing = await integrationRepository.findOwnedBy(
			rowId(organizationId, name),
			organizationId,
		)
		if (!existing) throw new NotFoundError("Integration")

		if (existing.kind === "email") {
			// Nothing to call: an email connection is the deployment's own SMTP,
			// and the honest check is whether it is configured at all.
			return { ok: true, detail: "Email connections are checked when a send is attempted." }
		}

		// Resolved through the same function a run uses, so a check cannot pass on
		// a row the agent would not have been allowed to reach.
		const workspaceId = organizationId ?? undefined

		try {
			const { row: full, secret } = await requireIntegration(name, existing.kind, workspaceId)
			const headers: Record<string, string> = { accept: "application/json" }
			if (secret && full.authHeader) {
				headers[full.authHeader] = `${full.authPrefix}${secret}`
			}

			const target =
				full.kind === "web_search"
					? `${(full.baseUrl ?? "https://api.tavily.com").replace(/\/+$/, "")}/search`
					: `${(full.baseUrl ?? "").replace(/\/+$/, "")}${full.allowedPathPrefix || "/"}`

			const response = await safeFetch(target, { method: "GET", headers })
			const ok = response.status < 500

			await integrationRepository.touch(full.id, {
				lastCheckedAt: new Date(),
				lastCheckOk: ok,
				// A 4xx from the far side is a real answer and proves the host is
				// reachable — it is recorded rather than treated as a failure,
				// because "405 Method Not Allowed" means the connection works.
				lastCheckError: ok ? null : `HTTP ${response.status}`,
			})

			return {
				ok,
				detail: `The host answered HTTP ${response.status}.`,
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "The check failed."
			await integrationRepository.touch(rowId(organizationId, name), {
				lastCheckedAt: new Date(),
				lastCheckOk: false,
				lastCheckError: message.slice(0, 500),
			})
			return { ok: false, detail: message }
		}
	},
}
