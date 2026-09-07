import { z } from "zod"

import { env } from "../../config/env"
import { providerRepository } from "../../modules/provider/provider.repository"
import { decryptSecret } from "../../shared/crypto"
import { logger } from "../../shared/logger"
import { endpointStatus, resolveEndpoint } from "./resolve"
import type { EndpointStatus, ResolvedEndpoint, SpeechCapability } from "./resolve"

const log = logger.child({ module: "speech-settings" })

/**
 * Where a speech credential lives.
 *
 * `provider_credential` is keyed by a free-text provider id and already carries
 * exactly what a speech endpoint needs: an encrypted key, its masked hint, a
 * base URL, and the outcome of the last check. These two ids are reserved for
 * that use rather than given a table of their own.
 *
 * They are deliberately *not* entries in `PROVIDER_DESCRIPTORS`. The models
 * screen maps over the descriptors, so a speech row is invisible there instead
 * of showing up as a chat provider that offers no models and cannot be picked.
 */
export const SPEECH_CREDENTIAL_IDS: Record<SpeechCapability, string> = {
	stt: "speech:stt",
	tts: "speech:tts",
}

/** The non-secret half of the configuration, as one `platform_setting` row. */
export const SPEECH_SETTINGS_KEY = "speech.config"

const storedSettingsSchema = z.object({
	stt: z.object({ model: z.string().min(1) }).nullable().default(null),
	tts: z
		.object({ model: z.string().min(1), voice: z.string().min(1) })
		.nullable()
		.default(null),
})

export type StoredSpeechSettings = z.infer<typeof storedSettingsSchema>

const EMPTY_SETTINGS: StoredSpeechSettings = { stt: null, tts: null }

export interface SpeechSnapshot {
	stt?: ResolvedEndpoint
	tts?: ResolvedEndpoint
	hints: Record<SpeechCapability, string | null>
}

/**
 * Read on every transcription and every read-aloud, and by two processes: the
 * API answers the request, the worker runs the agent tool. So it is cached with
 * a TTL rather than an invalidation callback, exactly as the model catalogue is
 * — a key changed in the console reaches the other process within `TTL_MS`
 * without a restart, and without a pub/sub channel for a table that changes a
 * few times a year.
 */
const TTL_MS = 30_000
let snapshot: { value: SpeechSnapshot; at: number } | undefined

/** Clears this process's copy, so whoever made the change sees it at once. */
export function invalidateSpeechSettings(): void {
	snapshot = undefined
}

function readStoredSettings(value: unknown): StoredSpeechSettings {
	const parsed = storedSettingsSchema.safeParse(value)
	if (parsed.success) return parsed.data
	// A row nobody can parse is a row an operator edited by hand. Falling back to
	// the environment is right; refusing to speak at all is not.
	log.warn("speech.settings_unreadable", { issues: parsed.error.issues.length })
	return EMPTY_SETTINGS
}

async function load(): Promise<SpeechSnapshot> {
	const [sttRow, ttsRow, setting] = await Promise.all([
		providerRepository.findCredential(SPEECH_CREDENTIAL_IDS.stt),
		providerRepository.findCredential(SPEECH_CREDENTIAL_IDS.tts),
		providerRepository.findSetting(SPEECH_SETTINGS_KEY),
	])
	const stored = readStoredSettings(setting?.value)

	/**
	 * A key that will not decrypt is a `SECRETS_ENCRYPTION_KEY` that was rotated
	 * out from under it. Treated as "no stored key" so the deployment falls back
	 * to the environment and keeps working, with a line in the log saying why.
	 */
	const decrypt = (row: { encryptedKey: string } | undefined, id: string) => {
		if (!row) return null
		try {
			return decryptSecret(row.encryptedKey)
		} catch {
			log.error("speech.credential_undecryptable", { credential: id })
			return null
		}
	}

	return {
		stt: resolveEndpoint(
			"stt",
			{
				baseUrl: sttRow?.baseUrl ?? null,
				apiKey: decrypt(sttRow, SPEECH_CREDENTIAL_IDS.stt),
				model: stored.stt?.model ?? null,
				voice: null,
			},
			env.speech.stt,
		),
		tts: resolveEndpoint(
			"tts",
			{
				baseUrl: ttsRow?.baseUrl ?? null,
				apiKey: decrypt(ttsRow, SPEECH_CREDENTIAL_IDS.tts),
				model: stored.tts?.model ?? null,
				voice: stored.tts?.voice ?? null,
			},
			env.speech.tts,
		),
		hints: { stt: sttRow?.keyHint ?? null, tts: ttsRow?.keyHint ?? null },
	}
}

export async function speechSnapshot(): Promise<SpeechSnapshot> {
	if (snapshot && Date.now() - snapshot.at < TTL_MS) return snapshot.value
	const value = await load()
	snapshot = { value, at: Date.now() }
	return value
}

/** The state the admin screen renders, for both halves. Never carries a key. */
export async function speechStatus(): Promise<Record<SpeechCapability, EndpointStatus>> {
	// Read past the cache: an admin who just saved a key must not be shown the
	// state from before they saved it.
	invalidateSpeechSettings()
	const current = await speechSnapshot()
	return {
		stt: endpointStatus(current.stt, current.hints.stt),
		tts: endpointStatus(current.tts, current.hints.tts),
	}
}
