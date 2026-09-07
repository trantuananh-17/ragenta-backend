/**
 * A billable duration for a recording whose transcriber did not report one.
 *
 * The ideal is the provider's own number, and it is what is used whenever it
 * arrives. But `verbose_json` is a request, not a guarantee: a self-hosted
 * server may answer plain `{ text }`, and OpenAI's own `gpt-4o-transcribe`
 * refuses `verbose_json` outright. Charging zero in that case is not caution —
 * it is unlimited free transcription against a real bill, and a deployment could
 * run in that state for months without anything visibly wrong.
 *
 * So the fallback is an estimate from the encoded size, and it is deliberately a
 * **floor**: the bitrates below are at the high end of what each container
 * carries in practice, which makes the derived seconds low. A customer is never
 * over-charged for a measurement nobody took, and the residual error is ours.
 * The usage row records that it was estimated, so the two are never confused
 * afterwards.
 */

/**
 * Bytes per second, per container, chosen high so the derived duration is low.
 *
 * Uncompressed formats are the reason this is a table and not one constant. A
 * WAV is roughly forty times the size of an Opus stream of the same length, so a
 * single ratio would either bill a WAV as forty times its length or an Opus
 * stream at a fortieth of it.
 */
const BYTES_PER_SECOND: Record<string, number> = {
	"audio/wav": 176_400, // 44.1 kHz, 16-bit, stereo
	"audio/x-wav": 176_400,
	"audio/flac": 88_200, // roughly half of PCM
	"audio/mpeg": 40_000, // 320 kbps
	"audio/mp4": 32_000, // 256 kbps AAC
	"audio/ogg": 24_000, // 192 kbps
	"audio/webm": 24_000,
}

/** What an unrecognised container is assumed to be: the densest compressed one. */
const DEFAULT_BYTES_PER_SECOND = 40_000

/**
 * Never zero for a file that exists. A one-byte upload is still a call somebody
 * made and a provider that answered, and rounding it away is how the free ride
 * comes back by another route.
 */
const MINIMUM_SECONDS = 1

export function estimateAudioSeconds(sizeBytes: number, mimeType: string): number {
	if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return MINIMUM_SECONDS
	const perSecond = BYTES_PER_SECOND[mimeType] ?? DEFAULT_BYTES_PER_SECOND
	return Math.max(MINIMUM_SECONDS, Math.floor(sizeBytes / perSecond))
}

export interface BillableDuration {
	seconds: number
	/** False when the provider measured it, true when this file derived it. */
	estimated: boolean
}

export function billableDuration(
	reported: number | null,
	sizeBytes: number,
	mimeType: string,
): BillableDuration {
	// A reported zero is treated as absent rather than as silence: every server
	// that reports honestly reports something above zero for audio it transcribed,
	// and a literal zero is far more likely to be a field that was never filled in.
	if (reported !== null && reported > 0) return { seconds: reported, estimated: false }
	return { seconds: estimateAudioSeconds(sizeBytes, mimeType), estimated: true }
}
