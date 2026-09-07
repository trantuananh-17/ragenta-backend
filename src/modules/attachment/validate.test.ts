import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"

import { ValidationError } from "../../shared/errors"
import {
	MAX_IMAGE_BYTES,
	MAX_IMAGE_EDGE_PIXELS,
	readImageDimensions,
	sniffImageMimeType,
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
