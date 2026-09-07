import { Buffer } from "node:buffer"

import { ValidationError } from "../../shared/errors"

/**
 * What an uploaded image is allowed to be, decided from its own bytes.
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
