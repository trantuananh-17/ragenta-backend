/**
 * Which speech configuration a deployment actually runs on.
 *
 * Two sources, in the same order provider keys use (ADR-021): a row written
 * through the admin console wins over the environment, because that one can be
 * rotated without a redeploy. The environment stays as the bootstrap — a
 * deployment with no `SECRETS_ENCRYPTION_KEY` can still transcribe.
 *
 * Kept free of `env` and the database so the rule itself can be tested: it is
 * the part with a decision in it, and the part that would silently point a key
 * at the wrong host if it were wrong.
 */

export type SpeechCapability = "stt" | "tts"

/** What the admin console stored, minus the secret. */
export interface StoredEndpoint {
	baseUrl: string | null
	apiKey: string | null
	model: string | null
	voice: string | null
}

export interface EnvironmentEndpoint {
	baseUrl: string
	apiKey: string
	model: string
	voice?: string
}

export interface ResolvedEndpoint {
	baseUrl: string
	apiKey: string
	model: string
	/** Synthesis only. A transcription endpoint takes no voice. */
	voice?: string
	source: "database" | "environment"
}

/**
 * A half is taken from the database only when the database holds *all* of it.
 *
 * Deliberately all-or-nothing rather than field-by-field: filling the gaps in a
 * half-written database row from the environment would aim one provider's key
 * at another provider's host — an OpenRouter key posted to `api.openai.com` —
 * and the failure that produces is a 401 that looks like a bad key rather than
 * a mixed configuration. An incomplete row means the console is mid-edit, and
 * the answer to mid-edit is the previous working configuration.
 */
export function resolveEndpoint(
	capability: SpeechCapability,
	stored: StoredEndpoint | undefined,
	environment: EnvironmentEndpoint | undefined,
): ResolvedEndpoint | undefined {
	const voiceRequired = capability === "tts"

	if (
		stored?.baseUrl &&
		stored.apiKey &&
		stored.model &&
		(!voiceRequired || stored.voice)
	) {
		return {
			baseUrl: stored.baseUrl,
			apiKey: stored.apiKey,
			model: stored.model,
			...(voiceRequired && stored.voice ? { voice: stored.voice } : {}),
			source: "database",
		}
	}

	if (environment && (!voiceRequired || environment.voice)) {
		return {
			baseUrl: environment.baseUrl,
			apiKey: environment.apiKey,
			model: environment.model,
			...(voiceRequired && environment.voice ? { voice: environment.voice } : {}),
			source: "environment",
		}
	}

	return undefined
}

/**
 * What the admin screen may see. Never the key — only the masked hint stored
 * beside it, for the same reason the provider screen returns one: an admin API
 * that can hand back a credential turns one stolen session into a stolen key.
 */
export interface EndpointStatus {
	configured: boolean
	source: "database" | "environment" | null
	baseUrl: string | null
	model: string | null
	voice: string | null
	keyHint: string | null
}

export function endpointStatus(
	resolved: ResolvedEndpoint | undefined,
	keyHint: string | null,
): EndpointStatus {
	return {
		configured: resolved !== undefined,
		source: resolved?.source ?? null,
		baseUrl: resolved?.baseUrl ?? null,
		model: resolved?.model ?? null,
		voice: resolved?.voice ?? null,
		// The hint belongs to the stored row, so it is shown only when that row is
		// the one in use; an environment key has no hint to show.
		keyHint: resolved?.source === "database" ? keyHint : null,
	}
}
