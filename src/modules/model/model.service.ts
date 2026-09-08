import {
	configuredProviders,
	findCatalogueModel,
	hasAdapter,
	isProviderConfigured,
	listCatalogue,
} from "../../ai/catalogue"
import type { ModelCapability } from "../../ai/models"
import { EntitlementError, ValidationError } from "../../shared/errors"
import { auditService } from "../audit/audit.service"
import { billingService } from "../billing/billing.service"
import { projectRepository } from "../project/project.repository"
import { providerService } from "../provider/provider.service"
import { planAllowsModel } from "./entitlement"
import { modelRepository } from "./model.repository"
import type { UpdateModelSettingsInput } from "./model.dto"

export interface ModelSelection {
	provider: string
	model: string
}

/**
 * Which model runs, and whether this workspace is allowed to run it.
 *
 * Two independent gates, and both matter:
 *   - **configured** — does this deployment hold an API key for the provider?
 *   - **entitled**   — does the workspace's plan include the model's tier?
 *
 * A model that fails either one is never offered and never resolved. The tier
 * gate is what keeps the free plan from costing money; the configured gate is
 * what stops a picker from offering something the server cannot call.
 */
export const modelService = {
	async listModels(workspaceId: string) {
		const [plan, catalogue, configured, access] = await Promise.all([
			billingService.getPlan(workspaceId),
			listCatalogue(),
			configuredProviders(),
			providerService.getPlanModelAccess(),
		])
		const planAccess = access[plan]
		const withKey = new Set(configured)

		return {
			plan,
			configuredProviders: configured,
			// A model an administrator switched off is not "not selectable", it is
			// not on offer at all — leaving it in the list with a reason would only
			// invite support questions about a model nobody may use.
			models: catalogue
				.filter((entry) => entry.enabled)
				.map((entry) => {
					const callable = withKey.has(entry.provider) && hasAdapter(entry.provider)
					const entitled = planAllowsModel(planAccess, plan, entry)
					return {
						provider: entry.provider,
						model: entry.model,
						capability: entry.capability,
						tier: entry.tier,
						// Coalesced rather than passed through: an embedding model has no
						// context window, and JSON.stringify drops an undefined value
						// entirely, so the key would be missing rather than null and every
						// client parsing this payload would reject the whole catalogue.
						contextWindow: entry.contextWindow ?? null,
						// `false`, not `null`: "this model cannot read an image" is a
						// definite fact rather than a missing one, and the composer uses
						// it to decide whether to offer an attach button at all. Same
						// coalescing reason as above — the key must always be present.
						vision: entry.vision ?? false,
						configured: callable,
						entitled,
						selectable: callable && entitled,
					}
				}),
		}
	},

	/**
	 * Current selection, falling back to the platform default so a workspace that
	 * has never opened settings still runs.
	 *
	 * The fallback is the administrator's choice, not a compiled constant. The
	 * built-in defaults name Anthropic and OpenAI, and a deployment holding
	 * neither key — one running entirely through OpenRouter, say — would have
	 * every workspace that never opened this screen resolve to a provider it
	 * cannot call. `providerService.getPlatformDefaults()` still ends at those
	 * constants when nothing has been set, so the chain is
	 * workspace → platform → built-in.
	 */
	async getSettings(workspaceId: string) {
		const row = await modelRepository.findSettings(workspaceId)
		if (row) {
			return {
				chat: { provider: row.chatProvider, model: row.chatModel },
				embedding: { provider: row.embeddingProvider, model: row.embeddingModel },
				isDefault: false,
			}
		}

		const [plan, access, platform] = await Promise.all([
			billingService.getPlan(workspaceId),
			providerService.getPlanModelAccess(),
			providerService.getPlatformDefaults(),
		])
		const planAccess = access[plan]

		return {
			chat: planAccess.chat.default ?? platform.chat,
			embedding: planAccess.embedding.default ?? platform.embedding,
			isDefault: true,
		}
	},

	async updateSettings(
		workspaceId: string,
		input: UpdateModelSettingsInput,
		actorId: string,
	) {
		const current = await this.getSettings(workspaceId)
		const chat = input.chat ?? current.chat
		const embedding = input.embedding ?? current.embedding

		await this.assertSelectable(workspaceId, chat, "chat")
		await this.assertSelectable(workspaceId, embedding, "embedding")

		const saved = await modelRepository.upsertSettings(workspaceId, {
			chatProvider: chat.provider,
			chatModel: chat.model,
			embeddingProvider: embedding.provider,
			embeddingModel: embedding.model,
		})

		await auditService.record({
			action: "workspace.models.updated",
			actorId,
			organizationId: workspaceId,
			targetType: "workspace_settings",
			targetId: workspaceId,
			metadata: { chat, embedding },
		})

		return {
			chat: { provider: saved?.chatProvider, model: saved?.chatModel },
			embedding: { provider: saved?.embeddingProvider, model: saved?.embeddingModel },
			isDefault: false,
		}
	},

	/**
	 * Full validation of one selection. Every path that can persist or run a
	 * model goes through here, so there is one answer to "is this allowed".
	 */
	async assertSelectable(
		workspaceId: string,
		selection: ModelSelection,
		capability: ModelCapability,
	) {
		const definition = await findCatalogueModel(selection.provider, selection.model)
		if (!definition || !definition.enabled) {
			throw new ValidationError(
				`Unknown model ${selection.provider}/${selection.model}.`,
				selection,
			)
		}

		if (definition.capability !== capability) {
			throw new ValidationError(
				`${selection.model} is a ${definition.capability} model and cannot be used for ${capability}.`,
				selection,
			)
		}

		if (!hasAdapter(definition.provider)) {
			throw new ValidationError(
				`This deployment has no client for the ${definition.provider} provider.`,
				selection,
			)
		}

		if (!(await isProviderConfigured(definition.provider))) {
			throw new ValidationError(
				`The ${definition.provider} provider is not configured on this deployment. ` +
					"An administrator must store its API key, or point the platform default " +
					"for this capability at a provider that has one.",
				selection,
			)
		}

		const [plan, access] = await Promise.all([
			billingService.getPlan(workspaceId),
			providerService.getPlanModelAccess(),
		])
		if (!planAllowsModel(access[plan], plan, definition)) {
			throw new EntitlementError(
				"MODEL_NOT_IN_PLAN",
				`The ${plan} plan does not include ${definition.model}.`,
				{ plan, ...selection, tier: definition.tier },
			)
		}
	},

	/**
	 * The chat model for a request: the project's override if it set one,
	 * otherwise the workspace default.
	 *
	 * Re-checks entitlement on the way out rather than trusting what was stored —
	 * a workspace that downgraded still has a premium model saved in its
	 * settings, and that must fail loudly instead of quietly billing for it.
	 */
	async resolveChatModel(workspaceId: string, projectId?: string): Promise<ModelSelection> {
		let selection: ModelSelection | undefined

		if (projectId) {
			const project = await projectRepository.findById(workspaceId, projectId)
			if (project?.chatProvider && project.chatModel) {
				selection = { provider: project.chatProvider, model: project.chatModel }
			}
		}

		selection ??= (await this.getSettings(workspaceId)).chat
		await this.assertSelectable(workspaceId, selection, "chat")
		return selection
	},

	async resolveEmbeddingModel(workspaceId: string): Promise<ModelSelection> {
		const selection = (await this.getSettings(workspaceId)).embedding
		await this.assertSelectable(workspaceId, selection, "embedding")
		return selection
	},
}
