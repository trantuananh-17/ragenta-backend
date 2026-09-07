import { Buffer } from "node:buffer"

import {
	SPEECH_CREDENTIAL_IDS,
	SPEECH_SETTINGS_KEY,
	invalidateSpeechSettings,
	requireSpeechToText,
	requireTextToSpeech,
	speechStatus,
} from "../../ai/speech"
import type { SpeechCapability } from "../../ai/speech"
import {
	EncryptionUnavailableError,
	encryptSecret,
	isEncryptionConfigured,
	maskSecret,
} from "../../shared/crypto"
import { NotFoundError, ValidationError } from "../../shared/errors"
import { logger } from "../../shared/logger"
import { auditService } from "../audit/audit.service"
import { providerRepository } from "../provider/provider.repository"
import type { SaveSpeechEndpointInput } from "./speech.admin.dto"

const log = logger.child({ module: "speech-admin" })

/**
 * One second of silence as a 16 kHz mono 16-bit WAV.
 *
 * The transcription check has to send audio, and audio it generates is the only
 * kind it can send without shipping a fixture. A second rather than a fraction
 * of one because several servers refuse a clip shorter than that as malformed,
 * and a valid configuration reported as broken is worse than the tenth of a cent
 * this costs.
 */
function silentWav(): Buffer {
	const sampleRate = 16_000
	const samples = sampleRate
	const dataBytes = samples * 2
	const buffer = Buffer.alloc(44 + dataBytes)

	buffer.write("RIFF", 0, "ascii")
	buffer.writeUInt32LE(36 + dataBytes, 4)
	buffer.write("WAVE", 8, "ascii")
	buffer.write("fmt ", 12, "ascii")
	buffer.writeUInt32LE(16, 16)
	buffer.writeUInt16LE(1, 20) // PCM
	buffer.writeUInt16LE(1, 22) // mono
	buffer.writeUInt32LE(sampleRate, 24)
	buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate
	buffer.writeUInt16LE(2, 32) // block align
	buffer.writeUInt16LE(16, 34) // bits per sample
	buffer.write("data", 36, "ascii")
	buffer.writeUInt32LE(dataBytes, 40)
	// The samples themselves stay zero: silence is what `Buffer.alloc` gives.
	return buffer
}

/** Where each half's non-secret settings live inside the one settings row. */
async function writeSettingsHalf(
	capability: SpeechCapability,
	value: { model: string; voice?: string } | null,
	actorId: string,
) {
	const existing = await providerRepository.findSetting(SPEECH_SETTINGS_KEY)
	const current = (existing?.value ?? {}) as Record<string, unknown>
	await providerRepository.upsertSetting(
		SPEECH_SETTINGS_KEY,
		{ ...current, [capability]: value },
		actorId,
	)
}

export const speechAdminService = {
	/**
	 * Both halves as the console renders them. The key is never in here — only
	 * the masked hint stored beside it, for the same reason the provider screen
	 * returns one: an admin API that can hand back a credential turns one stolen
	 * session into a stolen key that outlives it.
	 */
	async get() {
		return {
			encryptionConfigured: isEncryptionConfigured(),
			...(await speechStatus()),
		}
	},

	async save(capability: SpeechCapability, input: SaveSpeechEndpointInput, actorId: string) {
		if (!isEncryptionConfigured()) throw new EncryptionUnavailableError()

		if (capability === "tts" && !input.voice) {
			throw new ValidationError("Synthesis needs a voice: voice ids are server-specific.")
		}
		if (capability === "stt" && input.voice) {
			throw new ValidationError("A transcription endpoint takes no voice.")
		}

		const id = SPEECH_CREDENTIAL_IDS[capability]
		const existing = await providerRepository.findCredential(id)
		if (!input.apiKey && !existing) {
			throw new ValidationError("This endpoint has no stored key yet, so one is required.")
		}

		// Kept rather than re-typed when only the model or the host changed: the
		// console cannot show the key back, so requiring it on every edit would
		// mean pasting a secret to rename a model.
		const encryptedKey = input.apiKey ? encryptSecret(input.apiKey) : existing!.encryptedKey
		const keyHint = input.apiKey ? maskSecret(input.apiKey) : existing!.keyHint

		await providerRepository.upsertCredential({
			provider: id,
			encryptedKey,
			keyHint,
			baseUrl: input.baseUrl,
			updatedBy: actorId,
			// Whatever the last check said was about the old endpoint.
			lastCheckedAt: null,
			lastCheckOk: null,
			lastCheckError: null,
		})
		await writeSettingsHalf(
			capability,
			capability === "tts"
				? { model: input.model, voice: input.voice! }
				: { model: input.model },
			actorId,
		)
		invalidateSpeechSettings()

		await auditService.record({
			action: "speech.endpoint.saved",
			actorId,
			targetType: "provider_credential",
			targetId: id,
			// The key never reaches the audit trail — only that it changed, and who
			// changed it, which is the whole point of recording it.
			metadata: {
				capability,
				baseUrl: input.baseUrl,
				model: input.model,
				voice: input.voice ?? null,
				hint: keyHint,
				keyReplaced: input.apiKey !== undefined,
			},
		})

		return this.get()
	},

	/**
	 * Clears what the console stored. The deployment falls back to whatever the
	 * environment configures, which for most is nothing — so this is also how an
	 * operator turns speech off.
	 */
	async remove(capability: SpeechCapability, actorId: string) {
		const id = SPEECH_CREDENTIAL_IDS[capability]
		const removed = await providerRepository.deleteCredential(id)
		await writeSettingsHalf(capability, null, actorId)
		invalidateSpeechSettings()
		if (!removed) throw new NotFoundError("Speech credential")

		await auditService.record({
			action: "speech.endpoint.removed",
			actorId,
			targetType: "provider_credential",
			targetId: id,
			metadata: { capability },
		})

		return this.get()
	},

	/**
	 * Calls the endpoint for real. A configuration that parses is not a
	 * configuration that works: the model id, the host and the key are only
	 * proven together, and finding out at a customer's first recording is finding
	 * out too late.
	 */
	async check(capability: SpeechCapability, actorId: string) {
		const id = SPEECH_CREDENTIAL_IDS[capability]

		try {
			if (capability === "stt") {
				const provider = await requireSpeechToText()
				const result = await provider.transcribe({
					audio: silentWav(),
					fileName: "check.wav",
					mimeType: "audio/wav",
				})
				// Silence transcribes to nothing on a working server, so the check is
				// that a transcript came back at all, not that it said something.
				log.info("speech.check_ok", { capability, characters: result.text.length })
			} else {
				const provider = await requireTextToSpeech()
				const status = await speechStatus()
				const audio = await provider.synthesize({
					text: "Xin chào.",
					voice: status.tts.voice ?? "",
					format: "mp3",
				})
				if (audio.audio.length === 0) {
					throw new Error("The server returned no audio.")
				}
			}

			await providerRepository.recordCheck(id, { ok: true, error: null })
			await auditService.record({
				action: "speech.endpoint.checked",
				actorId,
				targetType: "provider_credential",
				targetId: id,
				metadata: { capability, ok: true },
			})
			return { ok: true, checkedAt: new Date() }
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "The speech server could not be reached."

			await providerRepository.recordCheck(id, { ok: false, error: message })
			log.warn("speech.check_failed", { capability, message })
			await auditService.record({
				action: "speech.endpoint.checked",
				actorId,
				targetType: "provider_credential",
				targetId: id,
				status: "failure",
				metadata: { capability, ok: false, message },
			})
			return { ok: false, checkedAt: new Date(), detail: message }
		}
	},
}
