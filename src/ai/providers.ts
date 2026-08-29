import { env } from "../config/env"
import { PROVIDERS } from "./models"
import type { ProviderName } from "./models"

/**
 * Which providers this deployment can actually call.
 *
 * Ragenta pays for inference, so the keys are server secrets from the
 * environment — never per-workspace rows, never anything a client can set. This
 * module is the only place that answers "do we have a key for X", so a model
 * whose provider is unconfigured can never be offered in a picker or resolved
 * for a request.
 *
 * It deliberately holds no SDK client: the AI layer that makes the calls does
 * not exist yet, and a client with no caller is a dependency with no purpose.
 */
export function isProviderConfigured(provider: ProviderName): boolean {
	return Boolean(env.providerKeys[provider])
}

export function configuredProviders(): ProviderName[] {
	return PROVIDERS.filter(isProviderConfigured)
}

/**
 * The key for a provider call. Throws rather than returning undefined: reaching
 * here without a key is a configuration failure, and the caller is about to make
 * a network request that would fail more confusingly.
 */
export function providerKey(provider: ProviderName): string {
	const key = env.providerKeys[provider]
	if (!key) {
		throw new Error(`No API key configured for provider "${provider}".`)
	}
	return key
}
