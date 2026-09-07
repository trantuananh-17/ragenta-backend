import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"

import { MAX_AUDIO_BYTES } from "../../ai/speech/types"
import { ValidationError } from "../../shared/errors"
import {
	MAX_IMAGE_BYTES,
	MAX_IMAGE_EDGE_PIXELS,
	readImageDimensions,
	sniffAudioMimeType,
	sniffImageMimeType,
	validateAudioUpload,
	validateImageUpload,
} from "./validate"

/**
 * What an upload is allowed to be, decided from bytes alone.
 *
 * The cases that matter are the disagreements: a file whose declared type, name
 * and contents tell three different stories is the ordinary shape of an attack
 * here, and every one of them has to end with the contents winning.
 */

function be32(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function be16(value: number): number[] {
	return [(value >>> 8) & 0xff, value & 0xff]
}

/** A real PNG header: signature, then the IHDR chunk a decoder reads the size from. */
function png(width: number, height: number): Buffer {
	return Buffer.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		...be32(13),
		0x49, 0x48, 0x44, 0x52,
		...be32(width),
		...be32(height),
		0x08, 0x06, 0x00, 0x00, 0x00,
	])
}

/** SOI, a short APP0 the scanner has to step over, then SOF0 carrying the size. */
function jpeg(width: number, height: number): Buffer {
	return Buffer.from([
		0xff, 0xd8,
		0xff, 0xe0, ...be16(4), 0x00, 0x00,
		0xff, 0xc0, ...be16(17), 0x08, ...be16(height), ...be16(width), 0x03,
	])
}

const WEBP = Buffer.from([
	0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
])

describe("sniffImageMimeType", () => {
	it("detects PNG", () => {
		expect(sniffImageMimeType(png(1, 1))).toBe("image/png")
	})

	it("detects JPEG", () => {
		expect(sniffImageMimeType(jpeg(1, 1))).toBe("image/jpeg")
	})

	it("detects WebP only when the RIFF form is WEBP", () => {
		expect(sniffImageMimeType(WEBP)).toBe("image/webp")
		const wav = Buffer.from(WEBP)
		wav.write("WAVE", 8, "ascii")
		expect(sniffImageMimeType(wav)).toBeUndefined()
	})

	it("detects both GIF versions", () => {
		expect(sniffImageMimeType(Buffer.from("GIF87a....", "ascii"))).toBe("image/gif")
		expect(sniffImageMimeType(Buffer.from("GIF89a....", "ascii"))).toBe("image/gif")
	})
})

describe("validateImageUpload", () => {
	it("stores the sniffed type, not the one the caller declared", () => {
		// The upload arrives as image/png named photo.png; the bytes are a JPEG.
		expect(validateImageUpload(jpeg(64, 32)).mimeType).toBe("image/jpeg")
	})

	it("refuses a file that matches no signature", () => {
		expect(() => validateImageUpload(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]))).toThrow(
			ValidationError,
		)
	})

	it("refuses a script payload named like an image", () => {
		const payload = Buffer.from("<script>fetch('/v1/me')</script>", "utf8")
		expect(() => validateImageUpload(payload)).toThrow(ValidationError)
	})

	it("refuses an empty file", () => {
		expect(() => validateImageUpload(Buffer.alloc(0))).toThrow(ValidationError)
	})

	it("refuses anything over the byte cap", () => {
		expect(() => validateImageUpload(Buffer.alloc(MAX_IMAGE_BYTES + 1))).toThrow(
			/larger than/,
		)
	})

	it("refuses a header claiming more pixels than a decoder should allocate", () => {
		expect(() => validateImageUpload(png(MAX_IMAGE_EDGE_PIXELS + 1, 10))).toThrow(
			/pixels or fewer/,
		)
	})

	it("accepts an image whose size cannot be read", () => {
		const truncated = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
		expect(validateImageUpload(truncated)).toEqual({
			mimeType: "image/png",
			sizeBytes: truncated.length,
			width: null,
			height: null,
		})
	})
})

describe("readImageDimensions", () => {
	it("reads a PNG IHDR", () => {
		expect(readImageDimensions(png(1280, 720), "image/png")).toEqual({
			width: 1280,
			height: 720,
		})
	})

	it("reads a JPEG SOF0 past the segments before it", () => {
		expect(readImageDimensions(jpeg(512, 300), "image/jpeg")).toEqual({
			width: 512,
			height: 300,
		})
	})

	it("returns null for a truncated PNG rather than throwing", () => {
		const truncated = png(1280, 720).subarray(0, 18)
		expect(readImageDimensions(truncated, "image/png")).toEqual({ width: null, height: null })
	})

	it("returns null for a JPEG that is only a signature", () => {
		expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg")).toEqual({
			width: null,
			height: null,
		})
	})

	it("returns null for garbage behind a valid signature", () => {
		const garbage = Buffer.concat([
			Buffer.from([0xff, 0xd8]),
			Buffer.from("not a jpeg at all, just bytes", "utf8"),
		])
		expect(readImageDimensions(garbage, "image/jpeg")).toEqual({ width: null, height: null })
	})

	it("does not guess a size for the containers it cannot measure", () => {
		expect(readImageDimensions(WEBP, "image/webp")).toEqual({ width: null, height: null })
	})
})

/**
 * Audio, where the signatures matter more than they do for images: the two
 * formats browsers actually produce — Chrome's WebM and Safari's MP4 — are both
 * containers whose declared type says nothing about what was written, and WAV
 * shares its first four bytes with WebP.
 */

/** `RIFF`, a size, then the form word that decides which RIFF this is. */
function riff(form: string): Buffer {
	const bytes = Buffer.alloc(16)
	bytes.write("RIFF", 0, "ascii")
	bytes.writeUInt32LE(8, 4)
	bytes.write(form, 8, "ascii")
	return bytes
}

/** A four-byte box length, then the `ftyp` box and its brand. */
function mp4(): Buffer {
	const bytes = Buffer.alloc(16)
	bytes.writeUInt32BE(16, 0)
	bytes.write("ftypisom", 4, "ascii")
	return bytes
}

describe("sniffAudioMimeType", () => {
	it("detects an Ogg container", () => {
		expect(sniffAudioMimeType(Buffer.from("OggS\x00\x02\x00\x00", "binary"))).toBe("audio/ogg")
	})

	it("detects WAV only when the RIFF form is WAVE", () => {
		expect(sniffAudioMimeType(riff("WAVE"))).toBe("audio/wav")
		expect(sniffAudioMimeType(riff("WEBP"))).toBeUndefined()
	})

	it("does not let a WAV pass as a WebP image", () => {
		// Both start `RIFF`, so a sniffer that stopped at the prefix would store a
		// voice note as a picture and a picture as a voice note.
		expect(sniffImageMimeType(riff("WAVE"))).toBeUndefined()
		expect(sniffImageMimeType(riff("WEBP"))).toBe("image/webp")
		expect(sniffAudioMimeType(riff("WEBP"))).toBeUndefined()
	})

	it("detects an MP3 with an ID3 tag", () => {
		expect(sniffAudioMimeType(Buffer.from("ID3\x03\x00\x00\x00\x00", "binary"))).toBe(
			"audio/mpeg",
		)
	})

	it("detects a bare MP3 frame sync", () => {
		expect(sniffAudioMimeType(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe("audio/mpeg")
		expect(sniffAudioMimeType(Buffer.from([0xff, 0xe3, 0x18, 0xc4]))).toBe("audio/mpeg")
	})

	it("does not read a JPEG's 0xFF as a frame sync", () => {
		expect(sniffAudioMimeType(jpeg(4, 4))).toBeUndefined()
	})

	it("detects FLAC", () => {
		expect(sniffAudioMimeType(Buffer.from("fLaC\x00\x00\x00\x22", "binary"))).toBe("audio/flac")
	})

	it("detects the EBML header Chrome's MediaRecorder writes", () => {
		expect(sniffAudioMimeType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00]))).toBe(
			"audio/webm",
		)
	})

	it("detects the ftyp box Safari's MediaRecorder writes, at offset 4", () => {
		expect(sniffAudioMimeType(mp4())).toBe("audio/mp4")
	})

	it("returns undefined for an image", () => {
		expect(sniffAudioMimeType(png(1, 1))).toBeUndefined()
		expect(sniffAudioMimeType(WEBP)).toBeUndefined()
	})
})

describe("validateAudioUpload", () => {
	it("stores the sniffed type and never a duration", () => {
		const wav = riff("WAVE")
		expect(validateAudioUpload(wav)).toEqual({
			mimeType: "audio/wav",
			sizeBytes: wav.length,
			durationMs: null,
		})
	})

	it("refuses a payload that is not audio", () => {
		expect(() => validateAudioUpload(Buffer.from("<script>alert(1)</script>", "utf8"))).toThrow(
			ValidationError,
		)
	})

	it("refuses a PNG offered as a recording", () => {
		expect(() => validateAudioUpload(png(8, 8))).toThrow(ValidationError)
	})

	it("refuses an empty file", () => {
		expect(() => validateAudioUpload(Buffer.alloc(0))).toThrow(ValidationError)
	})

	it("refuses anything over the byte cap", () => {
		expect(() => validateAudioUpload(Buffer.alloc(MAX_AUDIO_BYTES + 1))).toThrow(/larger than/)
	})
})
