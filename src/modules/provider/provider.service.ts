import {
	findCatalogueModel,
	invalidateCatalogue,
	listCatalogue,
	requireCredential,
} from "../../ai/catalogue"
import { PROVIDER_DESCRIPTORS, findProvider } from "../../ai/clients"
import { DEFAULT_CHAT, DEFAULT_EMBEDDING } from "../../ai/models"
import {
	EncryptionUnavailableError,
	encryptSecret,
	isEncryptionConfigured,
	maskSecret,
} from "../../shared/crypto"
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import { auditService } from "../audit/audit.service"
import { providerRepository } from "./provider.repository"
import type {
	PatchModelInput,
	SaveCredentialInput,
	SetPlatformDefaultsInput,
	UpsertModelInput,
} from "./provider.dto"

const log = logger.child({ module: "provider" })

export const MODEL_DEFAULTS_KEY = "model.defaults"

export interface PlatformModelDefaults {
	chat: { provider: string; model: string }
	embedding: { provider: string; model: string }
}

export const providerService = {
	/**
	 * The whole models screen in one payload: every provider Ragenta knows, its
	 * credential state, and the models it offers.
	 *
	 * The key is never in here — only `keyHint`, the masked form stored beside
	 * it. That is a hard rule, not a convenience: an admin API that can return a
	 * provider key turns one compromised admin session into a stolen credential
	 * that outlives it.
	 */
	async listProviders() {
		const [credentials, catalogue, defaults] = await Promise.all([
			providerRepository.listCredentials(),
			listCatalogue(),
			this.getPlatformDefaults(),
		])
		const byProvider = new Map(credentials.map((row) => [row.provider, row]))

		return {
			defaults,
			encryptionConfigured: isEncryptionConfigured(),
			providers: PROVIDER_DESCRIPTORS.map((descriptor) => {
				const credential = byProvider.get(descriptor.id)
				return {
					id: descriptor.id,
					name: descriptor.name,
					description: descriptor.description,
					supported: descriptor.client !== undefined,
					keyHint: descriptor.keyHint,
					requiresBaseUrl: descriptor.requiresBaseUrl ?? false,
					defaultBaseUrl: descriptor.client?.defaultBaseUrl ?? null,
					credential: {
						configured: credential !== undefined,
						hint: credential?.keyHint ?? null,
						baseUrl: credential?.baseUrl ?? null,
						updatedAt: credential?.updatedAt ?? null,
						lastCheckedAt: credential?.lastCheckedAt ?? null,
						lastCheckOk: credential?.lastCheckOk ?? null,
						lastCheckError: credential?.lastCheckError ?? null,
					},
					models: catalogue
						.filter((entry) => entry.provider === descriptor.id)
						.map((entry) => ({
							id: `${entry.provider}:${entry.model}`,
							provider: entry.provider,
							model: entry.model,
							capability: entry.capability,
							tier: entry.tier,
							contextWindow: entry.contextWindow ?? null,
							embeddingDimensions: entry.embeddingDimensions ?? null,
							rates: entry.rates,
							enabled: entry.enabled,
							custom: entry.custom,
						})),
				}
			}),
		}
	},

	async saveCredential(provider: string, input: SaveCredentialInput, actorId: string) {
		const descriptor = findProvider(provider)
		if (!descriptor) throw new NotFoundError("Provider")
		if (!isEncryptionConfigured()) throw new EncryptionUnavailableError()

		if (descriptor.requiresBaseUrl && !input.baseUrl) {
			throw new ValidationError(
				`${descriptor.name} has no default host, so a base URL is required.`,
			)
		}

		await providerRepository.upsertCredential({
			provider,
			encryptedKey: encryptSecret(input.apiKey),
			keyHint: maskSecret(input.apiKey),
			baseUrl: input.baseUrl ?? null,
			updatedBy: actorId,
			// A new key invalidates whatever the last check said about the old one.
			lastCheckedAt: null,
			lastCheckOk: null,
			lastCheckError: null,
		})
		invalidateCatalogue()

		// The key itself never reaches the audit trail — only that it changed and
		// who changed it, which is the whole point of recording it.
		await auditService.record({
			action: "provider.credential.saved",
			actorId,
			targetType: "provider_credential",
			targetId: provider,
			metadata: { provider, hint: maskSecret(input.apiKey), baseUrl: input.baseUrl ?? null },
		})

		return this.listProviders()
	},

	async removeCredential(provider: string, actorId: string) {
		const removed = await providerRepository.deleteCredential(provider)
		if (!removed) throw new NotFoundError("Provider credential")
		invalidateCatalogue()

		await auditService.record({
			action: "provider.credential.removed",
			actorId,
			targetType: "provider_credential",
			targetId: provider,
			metadata: { provider },
		})

		return this.listProviders()
	},

	/**
	 * One live call to the provider with the stored key.
	 *
	 * The failure is returned, not thrown: "your key is rejected" is the answer
	 * to the question, and a 502 would make the console show an error banner
	 * instead of the result an operator asked for. The outcome is written to the
	 * credential row so the state survives a page reload.
	 */
	async checkCredential(provider: string, actorId: string) {
		const descriptor = findProvider(provider)
		if (!descriptor) throw new NotFoundError("Provider")
		if (!descriptor.client) {
			throw new ConflictError(
				`This deployment has no client for ${descriptor.name}, so a key cannot be tested.`,
			)
		}

		const credential = await providerRepository.findCredential(provider)
		if (!credential) throw new NotFoundError("Provider credential")

		const resolved = await requireCredential(provider)

		try {
			const result = await descriptor.client.check(resolved)
			await providerRepository.recordCheck(provider, { ok: true, error: null })
			await auditService.record({
				action: "provider.credential.checked",
				actorId,
				targetType: "provider_credential",
				targetId: provider,
				metadata: { provider, ok: true },
			})
			return { ...result, ok: true, checkedAt: new Date() }
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "The provider could not be reached."

			await providerRepository.recordCheck(provider, { ok: false, error: message })
			log.warn("provider.check_failed", { provider, message })
			await auditService.record({
				action: "provider.credential.checked",
				actorId,
				targetType: "provider_credential",
				targetId: provider,
				status: "failure",
				metadata: { provider, ok: false, message },
			})
			return { ok: false, checkedAt: new Date(), detail: message }
		}
	},

	/**
	 * Adds a model or replaces the definition of one. Switching a built-in model
	 * off goes through here too, carrying its built-in values, so the database
	 * always holds a complete row rather than a patch against source.
	 */
	async upsertModel(input: UpsertModelInput, actorId: string) {
		const descriptor = findProvider(input.provider)
		if (!descriptor) throw new NotFoundError("Provider")

		if (input.capability === "embedding" && input.embeddingDimensions === null) {
			throw new ValidationError(
				"An embedding model needs its vector width — it decides which collection the vectors land in.",
			)
		}

		const row = await providerRepository.upsertModel({
			id: newId(),
			provider: input.provider,
			model: input.model,
			capability: input.capability,
			tier: input.tier,
			contextWindow: input.contextWindow,
			inputPerMillion: input.inputPerMillion.toFixed(6),
			outputPerMillion: input.outputPerMillion.toFixed(6),
			embeddingPerMillion: input.embeddingPerMillion.toFixed(6),
			embeddingDimensions: input.embeddingDimensions,
			enabled: input.enabled,
			createdBy: actorId,
		})
		invalidateCatalogue()

		await auditService.record({
			action: "provider.model.saved",
			actorId,
			targetType: "provider_model",
			targetId: row?.id ?? `${input.provider}:${input.model}`,
			metadata: { ...input },
		})

		return this.listProviders()
	},

	/**
	 * Edits one field of a model that may not have a row yet. A built-in model
	 * has no id until somebody changes something about it, so the patch is
	 * resolved against the merged catalogue and written as a full row.
	 */
	async patchModel(provider: string, model: string, patch: PatchModelInput, actorId: string) {
		const current = await findCatalogueModel(provider, model)
		if (!current) throw new NotFoundError("Model")

		return this.upsertModel(
			{
				provider,
				model,
				capability: patch.capability ?? current.capability,
				tier: patch.tier ?? current.tier,
				contextWindow: patch.contextWindow ?? current.contextWindow ?? null,
				inputPerMillion: patch.inputPerMillion ?? current.rates.input,
				outputPerMillion: patch.outputPerMillion ?? current.rates.output,
				embeddingPerMillion: patch.embeddingPerMillion ?? current.rates.embedding,
				embeddingDimensions:
					patch.embeddingDimensions ?? current.embeddingDimensions ?? null,
				enabled: patch.enabled ?? current.enabled,
			},
			actorId,
		)
	},

	/**
	 * Removes the database row for a model. A built-in one reverts to its
	 * compiled definition rather than disappearing — which is why this reports
	 * back what happened instead of a bare 204.
	 */
	async removeModel(provider: string, model: string, actorId: string) {
		const rows = await providerRepository.listModels()
		const row = rows.find((entry) => entry.provider === provider && entry.model === model)
		if (!row) throw new NotFoundError("Model")

		await providerRepository.deleteModel(row.id)
		invalidateCatalogue()

		await auditService.record({
			action: "provider.model.removed",
			actorId,
			targetType: "provider_model",
			targetId: row.id,
			metadata: { provider, model },
		})

		const revertedTo = await findCatalogueModel(provider, model)
		return {
			removed: true,
			revertedToBuiltIn: revertedTo !== undefined,
			providers: (await this.listProviders()).providers,
		}
	},

	/**
	 * What a workspace runs before it chooses. Stored as one settings row rather
	 * than two columns, because the pair only makes sense together.
	 */
	async getPlatformDefaults(): Promise<PlatformModelDefaults> {
		const row = await providerRepository.findSetting(MODEL_DEFAULTS_KEY)
		const stored = row?.value as Partial<PlatformModelDefaults> | undefined

		return {
			chat: stored?.chat ?? { ...DEFAULT_CHAT },
			embedding: stored?.embedding ?? { ...DEFAULT_EMBEDDING },
		}
	},

	async setPlatformDefaults(input: SetPlatformDefaultsInput, actorId: string) {
		const chat = await findCatalogueModel(input.chat.provider, input.chat.model)
		if (!chat || chat.capability !== "chat" || !chat.enabled) {
			throw new ValidationError("The chat default must be an offered chat model.", input.chat)
		}

		const embedding = await findCatalogueModel(
			input.embedding.provider,
			input.embedding.model,
		)
		if (!embedding || embedding.capability !== "embedding" || !embedding.enabled) {
			throw new ValidationError(
				"The embedding default must be an offered embedding model.",
				input.embedding,
			)
		}

		await providerRepository.upsertSetting(MODEL_DEFAULTS_KEY, input, actorId)

		await auditService.record({
			action: "platform.model_defaults.updated",
			actorId,
			targetType: "platform_setting",
			targetId: MODEL_DEFAULTS_KEY,
			metadata: { ...input },
		})

		return this.getPlatformDefaults()
	},
}
