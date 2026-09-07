import type { Buffer } from "node:buffer"

/**
 * Speech in and speech out, described so that neither side knows which engine
 * is behind it.
 *
 * Ragenta runs no Python in-process, so every model that transcribes or speaks
 * is a network hop whether it is hosted or a container on the same VM. Given
 * the hop is unavoidable, the wire format is the OpenAI audio API — not out of
 * preference for the vendor but because it is the shape both the hosted API and
 * the self-hosted servers already speak, so moving between them is a base URL
 * and a model name rather than a second adapter.
 *
 * Nothing here names a vendor, and nothing here may. A caller holds a
 * `TextToSpeechProvider` without knowing whether it is OpenAI or the Vietnamese
 * sidecar, which is the whole point: OpenAI publishes no Vietnamese voice at
 * all, so the deployment that serves Vietnamese customers is by definition the
 * one running something else.
 */

/** One timestamped span of a transcript, in the shape Whisper itself produces. */
export interface TranscriptSegment {
	/** Seconds from the start of the audio. */
	start: number
	end: number
	text: string
}

export interface TranscribeInput {
	audio: Buffer
	/** The container's own type — `audio/webm` from a browser recorder, say. */
	mimeType: string
	/**
	 * Sent as the multipart filename. Whisper servers decide how to decode from
	 * its extension, so a name with the wrong one fails to decode audio that is
	 * perfectly good. It is generated at the upload boundary from the type that
	 * was actually sniffed, never taken from what the client called the file.
	 */
	fileName: string
	/**
	 * ISO 639-1, e.g. `"vi"`. Left unset the server detects the language, which
	 * it does badly on short or noisy clips — a Vietnamese question of three
	 * words is routinely detected as Chinese — so a caller that knows should say.
	 */
	language?: string
	/**
	 * Vocabulary the model should expect: product names, acronyms, spellings it
	 * would otherwise normalise away. It is a hint to the decoder, not an
	 * instruction, and it is never built from untrusted text.
	 */
	prompt?: string
}

/**
 * A transcript, modelled on OpenAI's `verbose_json`.
 *
 * That is also, field for field, faster-whisper's own `Segment` and
 * `TranscriptionInfo` — not a coincidence, since faster-whisper mirrors
 * openai/whisper's structures — so this boundary is lossless in both
 * directions and needs no per-server mapping table.
 *
 * `segments` and `durationSec` are what a server returns only when it honours
 * the requested verbose format. One that answers with a bare `{ text }` is
 * still a working server, so they degrade to `[]` and to absent rather than to
 * an error; a caller that needs a duration for billing measures the audio it
 * uploaded instead of trusting a zero it cannot distinguish from silence.
 */
export interface TranscriptResult {
	text: string
	/** What the server detected, or the requested language when it reports none. */
	language?: string
	durationSec?: number
	segments: TranscriptSegment[]
}

/**
 * The container the audio comes back in. This *is* an enum, unlike `voice`,
 * because a container is a property of the protocol — every server speaking
 * this shape names its formats the same way, and the caller has to know the
 * type to serve the bytes.
 */
export type SpeechAudioFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm"

export interface SynthesizeInput {
	text: string
	/**
	 * A plain string the deployment configures, never a union of OpenAI's voice
	 * names. OpenAI has no Vietnamese voice, so hardcoding alloy/echo/nova would
	 * make the type itself unable to express the case this feature exists for;
	 * a self-hosted voice id, including a cloned one, is just another string.
	 */
	voice: string
	format: SpeechAudioFormat
	/** 0.25–4.0 where the server supports it; unset means the server's own default. */
	speed?: number
}

export interface SpeechResult {
	audio: Buffer
	mimeType: string
	/**
	 * Set only for `pcm`, which is raw samples with no header to carry it. Every
	 * other format describes itself, and a caller that guesses a rate for one of
	 * those would be guessing over the top of the container.
	 */
	sampleRate?: number
}

/**
 * A voice a provider says it has. `language` is the field that matters for
 * Ragenta and the one hosted OpenAI does not publish, so it stays optional
 * rather than being invented for it.
 */
export interface SpeechVoice {
	id: string
	name: string
	/** ISO 639-1 the voice speaks, where the server states it. */
	language?: string
}

export interface SpeechToTextProvider {
	readonly id: string
	transcribe(input: TranscribeInput, signal?: AbortSignal): Promise<TranscriptResult>
}

export interface TextToSpeechProvider {
	readonly id: string
	/**
	 * Declared, never inferred — for the same reason `supportsTools` is on
	 * `ProviderClient`. A server can accept a cloning request and quietly
	 * synthesise with a stock voice, and a plausible answer in the wrong voice
	 * is a failure nobody can detect from the outside.
	 */
	readonly supportsVoiceCloning?: boolean
	synthesize(input: SynthesizeInput, signal?: AbortSignal): Promise<SpeechResult>
	/**
	 * Absent where the server publishes no catalogue. A fixed list typed into
	 * Ragenta would be wrong for every self-hosted deployment, which is where
	 * the voices that matter live.
	 */
	listVoices?(): Promise<SpeechVoice[]>
}

/**
 * OpenAI's own upload cap, and a sane one regardless: 25 MB is roughly three
 * hours of speech-grade opus and about twenty-five minutes of wav, both of
 * which are already past what a request should carry.
 */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/**
 * The ceiling that actually binds. Transcription runs roughly in real time on a
 * CPU-only speaches container, so ten minutes of audio is ten minutes of a
 * worker — the byte cap above would let through a file that occupies one for an
 * afternoon.
 */
export const MAX_AUDIO_DURATION_SECONDS = 600

/**
 * What an upload may declare. Browsers give no choice here: Chrome's
 * MediaRecorder emits `audio/webm`, Safari's `audio/mp4`, and neither is
 * negotiable — so the list is led by what recorders actually produce, not by
 * what is pleasant to decode.
 *
 * This is the allowlist only. Nothing here sniffs bytes; the declared type is
 * the client's claim and is checked against the file's own signature at the
 * upload boundary, exactly as `src/modules/attachment/validate.ts` does for
 * images.
 */
export const AUDIO_MIME_TYPES = [
	"audio/webm",
	"audio/ogg",
	"audio/mpeg",
	"audio/mp4",
	"audio/wav",
	"audio/x-wav",
	"audio/flac",
] as const

export type AudioMimeType = (typeof AUDIO_MIME_TYPES)[number]
