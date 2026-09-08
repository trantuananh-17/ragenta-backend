import { Buffer } from "node:buffer"

import { MAX_AUDIO_BYTES } from "../../ai/speech/types"
import type { AudioMimeType } from "../../ai/speech/types"
import { ValidationError } from "../../shared/errors"

/**
 * What an uploaded file is allowed to be, decided from its own bytes.
 *
 * The declared content type is deliberately not an input to any function here.
 * It is whatever the caller put in the multipart part, and the type we keep is
 * the one later inlined into a provider request as a `data:` URL — so a lie
 * there is a malformed provider call at best, and a `text/html` we hand back
 * from our own origin at worst. The signature in the first bytes is the only
 * thing that decides (`.claude/rules/security.md`).
 */

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number]

/**
 * Memory, not storage. The bytes are held whole to sniff, to store and again to
 * base64 them into a prompt, and the last of those inflates them by a third.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * A guard against an image whose header claims a size no decoder should be asked
 * to allocate. Applied only when the header actually yielded one — see
 * `readImageDimensions`.
 */
export const MAX_IMAGE_EDGE_PIXELS = 12_000

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
const GIF87A_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]
const GIF89A_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46]
const WEBP_FORM = [0x57, 0x45, 0x42, 0x50]
const PNG_IHDR = [0x49, 0x48, 0x44, 0x52]

function matches(bytes: Buffer, offset: number, pattern: readonly number[]): boolean {
	if (bytes.length < offset + pattern.length) return false
	return pattern.every((byte, index) => bytes[offset + index] === byte)
}

export function sniffImageMimeType(bytes: Buffer): ImageMimeType | undefined {
	if (matches(bytes, 0, PNG_SIGNATURE)) return "image/png"
	if (matches(bytes, 0, JPEG_SIGNATURE)) return "image/jpeg"
	if (matches(bytes, 0, GIF87A_SIGNATURE) || matches(bytes, 0, GIF89A_SIGNATURE)) {
		return "image/gif"
	}
	// WebP is a RIFF container, and RIFF alone is also WAV and AVI. The form only
	// shows in the fourth word, so both halves have to match.
	if (matches(bytes, 0, RIFF_SIGNATURE) && matches(bytes, 8, WEBP_FORM)) return "image/webp"
	return undefined
}

export interface ImageDimensions {
	width: number | null
	height: number | null
}

/** Null is an expected answer, not a failure — see `readImageDimensions`. */
const UNKNOWN_DIMENSIONS: ImageDimensions = { width: null, height: null }

function uint16(bytes: Buffer, offset: number): number | undefined {
	const high = bytes[offset]
	const low = bytes[offset + 1]
	if (high === undefined || low === undefined) return undefined
	return high * 0x100 + low
}

function uint32(bytes: Buffer, offset: number): number | undefined {
	const high = uint16(bytes, offset)
	const low = uint16(bytes, offset + 2)
	if (high === undefined || low === undefined) return undefined
	return high * 0x10000 + low
}

function pngDimensions(bytes: Buffer): ImageDimensions {
	// IHDR is required to be the first chunk, so its offset is fixed and a file
	// where it is not there is truncated or not really a PNG.
	if (!matches(bytes, 12, PNG_IHDR)) return UNKNOWN_DIMENSIONS
	const width = uint32(bytes, 16)
	const height = uint32(bytes, 20)
	if (width === undefined || height === undefined) return UNKNOWN_DIMENSIONS
	return { width, height }
}

/** SOF0..SOF15 carry the frame size; DHT, JPG and DAC sit in the same range and do not. */
function isStartOfFrame(marker: number): boolean {
	return (
		marker >= 0xc0 &&
		marker <= 0xcf &&
		marker !== 0xc4 &&
		marker !== 0xc8 &&
		marker !== 0xcc
	)
}

function jpegDimensions(bytes: Buffer): ImageDimensions {
	let offset = 2
	while (offset + 1 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset += 1
			continue
		}
		const marker = bytes[offset + 1]
		if (marker === undefined) break
		// A run of 0xFF is padding before the real marker.
		if (marker === 0xff) {
			offset += 1
			continue
		}
		// Standalone markers carry no length field to step over.
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2
			continue
		}
		// The frame header always precedes the scan, so past SOS there are no more
		// markers to find — only entropy-coded bytes that look like them.
		if (marker === 0xda || marker === 0xd9) return UNKNOWN_DIMENSIONS

		const segmentLength = uint16(bytes, offset + 2)
		if (segmentLength === undefined || segmentLength < 2) return UNKNOWN_DIMENSIONS
		if (isStartOfFrame(marker)) {
			const height = uint16(bytes, offset + 5)
			const width = uint16(bytes, offset + 7)
			if (width === undefined || height === undefined) return UNKNOWN_DIMENSIONS
			return { width, height }
		}
		offset += 2 + segmentLength
	}
	return UNKNOWN_DIMENSIONS
}

/**
 * Best effort by design. A cropped upload, a progressive variant we do not walk
 * or a container we do not measure all answer null, and null is a supported
 * state on the row: the composer lays the image out after it loads instead of
 * before. Nothing here throws — an unmeasurable image is still a usable one.
 */
export function readImageDimensions(bytes: Buffer, mimeType: ImageMimeType): ImageDimensions {
	if (mimeType === "image/png") return pngDimensions(bytes)
	if (mimeType === "image/jpeg") return jpegDimensions(bytes)
	// WebP stores its size differently in each of VP8, VP8L and VP8X, and a GIF's
	// header carries the logical screen rather than the frame, which is not the
	// same number. Neither is worth a parser that would sometimes be wrong.
	return UNKNOWN_DIMENSIONS
}

export interface ValidatedImage {
	/** Sniffed, never declared. This is what gets stored and sent to a provider. */
	mimeType: ImageMimeType
	sizeBytes: number
	width: number | null
	height: number | null
}

export function validateImageUpload(bytes: Buffer): ValidatedImage {
	if (bytes.length === 0) throw new ValidationError("The image is empty.")
	if (bytes.length > MAX_IMAGE_BYTES) {
		throw new ValidationError(
			`The image is larger than the ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB limit.`,
		)
	}

	const mimeType = sniffImageMimeType(bytes)
	if (!mimeType) {
		throw new ValidationError(
			"Attach a PNG, JPEG, WebP or GIF image. The file's contents are none of those, whatever it is named.",
		)
	}

	const { width, height } = readImageDimensions(bytes, mimeType)
	// Only checked when the header gave a size. An unmeasurable image is not
	// refused for that: the byte cap above already bounds what it can cost.
	if (
		(width !== null && width > MAX_IMAGE_EDGE_PIXELS) ||
		(height !== null && height > MAX_IMAGE_EDGE_PIXELS)
	) {
		throw new ValidationError(
			`Each side of the image must be ${MAX_IMAGE_EDGE_PIXELS} pixels or fewer.`,
		)
	}

	return { mimeType, sizeBytes: bytes.length, width, height }
}

/**
 * What an uploaded recording is allowed to be, decided the same way: from the
 * first bytes, never from the declared type. A browser's MediaRecorder labels
 * its output for the codec it negotiated rather than the container it wrote, so
 * the declared type here is wrong often enough to be useless even when nobody
 * is lying.
 */

const OGG_SIGNATURE = [0x4f, 0x67, 0x67, 0x53]
const WAVE_FORM = [0x57, 0x41, 0x56, 0x45]
const ID3_SIGNATURE = [0x49, 0x44, 0x33]
const FLAC_SIGNATURE = [0x66, 0x4c, 0x61, 0x43]
const EBML_SIGNATURE = [0x1a, 0x45, 0xdf, 0xa3]
const FTYP_BOX = [0x66, 0x74, 0x79, 0x70]

/**
 * An MPEG audio frame header: eleven set bits, so the second byte is 0xEx or
 * 0xFx. An MP3 without an ID3 tag starts on one, and a JPEG cannot be mistaken
 * for it — its second byte is 0xD8, outside that range.
 */
function isMpegFrameSync(bytes: Buffer): boolean {
	const first = bytes[0]
	const second = bytes[1]
	if (first === undefined || second === undefined) return false
	return first === 0xff && (second & 0xe0) === 0xe0
}

export function sniffAudioMimeType(bytes: Buffer): AudioMimeType | undefined {
	if (matches(bytes, 0, OGG_SIGNATURE)) return "audio/ogg"
	// RIFF is WAV, WebP and AVI alike, so the form in the fourth word decides —
	// the mirror of the WebP check above. Getting this wrong either way stores a
	// recording as a picture or refuses a perfectly good one.
	if (matches(bytes, 0, RIFF_SIGNATURE) && matches(bytes, 8, WAVE_FORM)) return "audio/wav"
	if (matches(bytes, 0, ID3_SIGNATURE) || isMpegFrameSync(bytes)) return "audio/mpeg"
	if (matches(bytes, 0, FLAC_SIGNATURE)) return "audio/flac"
	// EBML, the Matroska header WebM inherits. This is what Chrome's MediaRecorder
	// produces, so it is the common case rather than an exotic one.
	if (matches(bytes, 0, EBML_SIGNATURE)) return "audio/webm"
	// ISO base media: the `ftyp` box, which is preceded by its own four-byte
	// length, so it sits at 4 rather than at 0. Safari's MediaRecorder writes it.
	if (matches(bytes, 4, FTYP_BOX)) return "audio/mp4"
	return undefined
}

export interface ValidatedAudio {
	/** Sniffed, never declared. This is what gets stored and sent to transcription. */
	mimeType: AudioMimeType
	sizeBytes: number
	/**
	 * Always null. Duration is not read from the container here: each of these
	 * formats hides it somewhere different — WebM needs the EBML segment info,
	 * MP3 has no duration field at all and is estimated by scanning every frame,
	 * MP4 needs the moov atom that a streamed recording puts at the *end* — and a
	 * wrong number here would be a wrong bill. Transcription reports `durationSec`
	 * authoritatively, and that is what the row and the charge are set from.
	 */
	durationMs: null
}

export function validateAudioUpload(bytes: Buffer): ValidatedAudio {
	if (bytes.length === 0) throw new ValidationError("The recording is empty.")
	if (bytes.length > MAX_AUDIO_BYTES) {
		throw new ValidationError(
			`The recording is larger than the ${Math.floor(MAX_AUDIO_BYTES / 1024 / 1024)} MB limit.`,
		)
	}

	const mimeType = sniffAudioMimeType(bytes)
	if (!mimeType) {
		throw new ValidationError(
			"Attach a WebM, MP4, OGG, MP3, WAV or FLAC recording. The file's contents are none of those, whatever it is named.",
		)
	}

	return { mimeType, sizeBytes: bytes.length, durationMs: null }
}

/**
 * Spreadsheets, which are the one non-media file a run has a step for.
 *
 * Deliberately only xlsx. `excel_read` opens what is stored with ExcelJS, so a
 * kind nothing can read would be a file the product accepts and then refuses to
 * do anything with — worse than refusing it at the door.
 */
export const WORKBOOK_MIME_TYPE =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/** The same ceiling `excel_read` parses under: storing more than can be opened is a trap. */
export const MAX_WORKBOOK_BYTES = 15 * 1024 * 1024

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]

/**
 * An xlsx is a ZIP, and so is a docx, a pptx, a jar and an ordinary archive —
 * the four magic bytes say nothing about which. What separates them is the
 * entry names, and ZIP stores those **uncompressed** in both the local headers
 * and the central directory, so the workbook part is findable as plain bytes
 * without inflating anything.
 *
 * `xl/workbook.xml` rather than `[Content_Types].xml`, which every OOXML file
 * has: a docx renamed to .xlsx must not pass, and the extension is not an input
 * here any more than a declared content type is anywhere else in this file.
 */
export function sniffWorkbookMimeType(bytes: Buffer): typeof WORKBOOK_MIME_TYPE | undefined {
	if (!matches(bytes, 0, ZIP_SIGNATURE)) return undefined
	return bytes.includes("xl/workbook.xml") ? WORKBOOK_MIME_TYPE : undefined
}

export interface ValidatedWorkbook {
	mimeType: typeof WORKBOOK_MIME_TYPE
	sizeBytes: number
}

export function validateWorkbookUpload(bytes: Buffer): ValidatedWorkbook {
	if (bytes.length > MAX_WORKBOOK_BYTES) {
		throw new ValidationError(
			`The spreadsheet is larger than the ${Math.floor(MAX_WORKBOOK_BYTES / 1024 / 1024)} MB limit.`,
		)
	}

	const mimeType = sniffWorkbookMimeType(bytes)
	if (!mimeType) throw new ValidationError("That is not an .xlsx workbook.")

	return { mimeType, sizeBytes: bytes.length }
}
