import { AppError } from "../../shared/errors"
import { createSpeechToText, createTextToSpeech } from "./openai-compatible"
import type { ResolvedEndpoint, SpeechCapability } from "./resolve"
import { speechSnapshot } from "./settings"
import type { SpeechToTextProvider, TextToSpeechProvider } from "./types"

/**
 * The speech providers this deployment can actually call.
 *
 * Transcription and synthesis are resolved separately because they are bought
 * separately: a deployment can transcribe with hosted OpenAI while speaking
 * Vietnamese through a self-hosted sidecar, and one half being configured
 * without the other is the ordinary case. Neither is required for the platform
 * to run, so an unconfigured half is `undefined` here rather than a startup
 * failure.
 *
 * Resolved per call rather than once at import: the configuration now lives in
 * the database as well as the environment, and a key saved in the admin console
 * has to reach the worker without restarting it. `settings.ts` does the caching,
 * so this stays a cheap lookup and a closure.
 */
export class SpeechUnavailableError extends AppError {
	constructor(capability: "transcription" | "synthesis") {
		super(
			"SPEECH_UNAVAILABLE",
			capability === "transcription"
				? "Speech-to-text is not configured, so this deployment cannot transcribe audio."
				: "Text-to-speech is not configured, so this deployment cannot generate speech.",
			503,
		)
	}
}

/** Undefined rather than a throw: most callers are deciding whether to offer something. */
export async function speechToText(): Promise<SpeechToTextProvider | undefined> {
	const { stt } = await speechSnapshot()
	if (!stt) return undefined
	return createSpeechToText({
		id: "speech-to-text",
		baseUrl: stt.baseUrl,
		apiKey: stt.apiKey,
		model: stt.model,
	})
}

export async function textToSpeech(): Promise<TextToSpeechProvider | undefined> {
	const { tts } = await speechSnapshot()
	if (!tts) return undefined
	return createTextToSpeech({
		id: "text-to-speech",
		baseUrl: tts.baseUrl,
		apiKey: tts.apiKey,
		model: tts.model,
	})
}

export async function isSpeechToTextConfigured(): Promise<boolean> {
	return (await speechSnapshot()).stt !== undefined
}

export async function isTextToSpeechConfigured(): Promise<boolean> {
	return (await speechSnapshot()).tts !== undefined
}

/** For the one place that is about to transcribe, and must refuse clearly if it cannot. */
export async function requireSpeechToText(): Promise<SpeechToTextProvider> {
	const provider = await speechToText()
	if (!provider) throw new SpeechUnavailableError("transcription")
	return provider
}

export async function requireTextToSpeech(): Promise<TextToSpeechProvider> {
	const provider = await textToSpeech()
	if (!provider) throw new SpeechUnavailableError("synthesis")
	return provider
}

/**
 * The endpoint a call will actually run against. The service that charges for
 * the call needs its model name for the ledger line, which the provider closure
 * itself does not expose.
 */
export async function resolvedSpeechEndpoint(
	capability: SpeechCapability,
): Promise<ResolvedEndpoint | undefined> {
	return (await speechSnapshot())[capability]
}

/**
 * The voice this deployment speaks with. There is no default worth shipping:
 * OpenAI's voice names mean nothing to a VieNeu sidecar and none of them speak
 * Vietnamese, so the deployment names its own or has no synthesis at all.
 */
export async function defaultSpeechVoice(): Promise<string | undefined> {
	return (await speechSnapshot()).tts?.voice
}

export * from "./types"
export type { EndpointStatus, ResolvedEndpoint, SpeechCapability } from "./resolve"
export {
	invalidateSpeechSettings,
	speechStatus,
	SPEECH_CREDENTIAL_IDS,
	SPEECH_SETTINGS_KEY,
} from "./settings"
