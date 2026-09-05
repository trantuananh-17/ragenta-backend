import { env } from "../config/env"
import { decryptSecret } from "../shared/crypto"
import { logger } from "../shared/logger"
import { providerRepository } from "../modules/provider/provider.repository"
import { PROVIDER_DESCRIPTORS, providerClient } from "./clients"
import type { ProviderCredential } from "./clients"
import { MODELS, modelKey } from "./models"
import type { ModelCapability, ModelDefinition } from "./models"

const log = logger.child({ module: "catalogue" })

/**
 * The live view of "what can this deployment run": the built-in catalogue with
 * the database's rows merged over it, and the credentials that make a model
 * callable.
 *
 * Read on nearly every AI request, so it is cached — but only for seconds. The
 * API and the worker are separate processes and a key rotated through the admin
 * console has to reach the worker without a restart, so there is a TTL rather
 * than an invalidation callback. `invalidate()` clears the local copy so the
 * process that made the change sees it at once; the other one is at most
 * `TTL_MS` behind, which is the cost of not building a pub/sub channel for a
 * table that changes a few times a year.
 */
const TTL_MS = 30_000

export interface CatalogueModel extends ModelDefinition {
	/** True when it came from `provider_model` rather than `src/ai/models.ts`. */
	custom: boolean
	enabled: boolean
}

interface Snapshot {
	at: number
	models: CatalogueModel[]
	credentials: Map<string, ProviderCredential>
	/** Providers holding a key, whether from the database or the environment. */
	configured: Set<string>
}

let snapshot: Snapshot | undefined
let inFlight: Promise<Snapshot> | undefined

/**
 * Provider keys still readable from the environment. Kept as a fallback so an
 * existing deployment keeps working through the change, and so a machine with
 * no `SECRETS_ENCRYPTION_KEY` can still run. A database row wins: it is the one
 * an operator can rotate without a redeploy.
 */
const ENV_KEYS: Record<string, string | undefined> = {
	openai: env.providerKeys.openai,
	anthropic: env.providerKeys.anthropic,
	google: env.providerKeys.google,
}

async function load(): Promise<Snapshot> {
	const [rows, credentialRows] = await Promise.all([
		providerRepository.listModels(),
		providerRepository.listCredentials(),
	])

	const byKey = new Map<string, CatalogueModel>(
		MODELS.map((entry) => [
			modelKey(entry.provider, entry.model),
			{ ...entry, custom: false, enabled: true },
		]),
	)

	for (const row of rows) {
		byKey.set(modelKey(row.provider, row.model), {
			provider: row.provider,
			model: row.model,
			capability: row.capability as ModelCapability,
			tier: row.tier as CatalogueModel["tier"],
			rates: {
				input: Number(row.inputPerMillion),
				output: Number(row.outputPerMillion),
				embedding: Number(row.embeddingPerMillion),
			},
			contextWindow: row.contextWindow ?? undefined,
			embeddingDimensions: row.embeddingDimensions ?? undefined,
			custom: true,
			enabled: row.enabled,
		})
	}

	const credentials = new Map<string, ProviderCredential>()

	for (const [provider, apiKey] of Object.entries(ENV_KEYS)) {
		if (apiKey) credentials.set(provider, { apiKey })
	}

	for (const row of credentialRows) {
		try {
			credentials.set(row.provider, {
				apiKey: decryptSecret(row.encryptedKey),
				baseUrl: row.baseUrl ?? undefined,
			})
		} catch (error) {
			// A row that will not decrypt means the encryption key changed. Log it
			// and leave any environment key in place rather than taking the whole
			// catalogue down — the admin console shows the provider as unconfigured,
			// which is the signal to store the key again.
			log.error("credential.decrypt_failed", error, { provider: row.provider })
		}
	}

	return {
		at: Date.now(),
		models: [...byKey.values()],
		credentials,
		configured: new Set(credentials.keys()),
	}
}

async function current(): Promise<Snapshot> {
	if (snapshot && Date.now() - snapshot.at < TTL_MS) return snapshot
	// Collapse concurrent misses onto one read: a burst of chat requests after
	// the TTL expires should not each open its own query.
	inFlight ??= load().finally(() => {
		inFlight = undefined
	})
	snapshot = await inFlight
	return snapshot
}

export function invalidateCatalogue(): void {
	snapshot = undefined
}

export async function listCatalogue(): Promise<CatalogueModel[]> {
	return (await current()).models
}

/** Only the models a picker may offer: enabled, and their provider holds a key. */
export async function listOfferedModels(): Promise<CatalogueModel[]> {
	const state = await current()
	return state.models.filter(
		(entry) => entry.enabled && state.configured.has(entry.provider),
	)
}

export async function findCatalogueModel(
	provider: string,
	model: string,
): Promise<CatalogueModel | undefined> {
	const key = modelKey(provider, model)
	return (await current()).models.find(
		(entry) => modelKey(entry.provider, entry.model) === key,
	)
}

export async function isProviderConfigured(provider: string): Promise<boolean> {
	return (await current()).configured.has(provider)
}

export async function configuredProviders(): Promise<string[]> {
	return [...(await current()).configured]
}

/**
 * The credential for a provider call. Undefined rather than a throw: the caller
 * is usually deciding whether to offer something, and the one place that is
 * about to make a network request uses `requireCredential` instead.
 */
export async function findCredential(
	provider: string,
): Promise<ProviderCredential | undefined> {
	return (await current()).credentials.get(provider)
}

export async function requireCredential(provider: string): Promise<ProviderCredential> {
	const credential = await findCredential(provider)
	if (!credential) {
		throw new Error(`No API key configured for provider "${provider}".`)
	}
	return credential
}

/** Providers that have an adapter, hold a key, and therefore work right now. */
export async function callableProviders(): Promise<string[]> {
	const state = await current()
	return PROVIDER_DESCRIPTORS.filter(
		(descriptor) => descriptor.client && state.configured.has(descriptor.id),
	).map((descriptor) => descriptor.id)
}

export function hasAdapter(provider: string): boolean {
	return providerClient(provider) !== undefined
}
