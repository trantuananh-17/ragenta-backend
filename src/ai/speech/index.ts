import { env } from "../../config/env"
import { AppError } from "../../shared/errors"
import { createSpeechToText, createTextToSpeech } from "./openai-compatible"
import type { SpeechToTextProvider, TextToSpeechProvider } from "./types"

/**
 * The speech providers this deployment can actually call.
 *
 * Transcription and synthesis are resolved separately because they are bought
 * separately: a deployment can transcribe with hosted OpenAI while speaking
 * Vietnamese through a self-hosted sidecar, and the common case at the start of
 * Phase 2 is exactly one of the two being configured. Neither is required for
 * the platform to run, so an unconfigured half is `undefined` here rather than
 * a startup failure.
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

const stt = env.speech.stt
	? createSpeechToText({
			id: "speech-to-text",
			baseUrl: env.speech.stt.baseUrl,
			apiKey: env.speech.stt.apiKey,
			model: env.speech.stt.model,
		})
	: undefined

const tts = env.speech.tts
	? createTextToSpeech({
			id: "text-to-speech",
			baseUrl: env.speech.tts.baseUrl,
			apiKey: env.speech.tts.apiKey,
			model: env.speech.tts.model,
		})
	: undefined

/** Undefined rather than a throw: most callers are deciding whether to offer something. */
export function speechToText(): SpeechToTextProvider | undefined {
	return stt
}

export function textToSpeech(): TextToSpeechProvider | undefined {
	return tts
}

export function isSpeechToTextConfigured(): boolean {
	return stt !== undefined
}

export function isTextToSpeechConfigured(): boolean {
	return tts !== undefined
}

/** For the one place that is about to transcribe, and must refuse clearly if it cannot. */
export function requireSpeechToText(): SpeechToTextProvider {
	if (!stt) throw new SpeechUnavailableError("transcription")
	return stt
}

export function requireTextToSpeech(): TextToSpeechProvider {
	if (!tts) throw new SpeechUnavailableError("synthesis")
	return tts
}

/**
 * The voice this deployment speaks with. There is no default worth shipping:
 * OpenAI's voice names mean nothing to a VieNeu sidecar and none of them speak
 * Vietnamese, so the deployment names its own or has no synthesis at all.
 */
export function defaultSpeechVoice(): string | undefined {
	return env.speech.tts?.voice
}

export * from "./types"
