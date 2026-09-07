import { describe, expect, it } from "vitest"

import { billableDuration, estimateAudioSeconds } from "./duration"

describe("billableDuration", () => {
	it("uses the provider's own measurement when there is one", () => {
		expect(billableDuration(42.5, 1_000_000, "audio/webm")).toEqual({
			seconds: 42.5,
			estimated: false,
		})
	})

	it("estimates rather than charging zero when the server reports nothing", () => {
		// The bug this exists for: a server answering plain `{ text }` billed the
		// workspace nothing, so a deployment could transcribe without limit against
		// a real provider invoice and nothing would look wrong.
		const result = billableDuration(null, 2_400_000, "audio/webm")
		expect(result.estimated).toBe(true)
		expect(result.seconds).toBeGreaterThan(0)
	})

	it("treats a reported zero as absent, not as silence", () => {
		// Every server that measures honestly reports something above zero for
		// audio it actually transcribed. A literal zero is a field nobody filled in.
		expect(billableDuration(0, 1_000_000, "audio/mpeg").estimated).toBe(true)
	})
})

describe("estimateAudioSeconds", () => {
	it("does not bill a WAV as though it were compressed", () => {
		// A WAV is roughly forty times the size of an Opus stream of the same
		// length. One ratio for both would bill it as forty times its duration.
		const wav = estimateAudioSeconds(1_764_000, "audio/wav")
		const opus = estimateAudioSeconds(1_764_000, "audio/ogg")
		expect(wav).toBeLessThan(opus)
		expect(wav).toBe(10)
	})

	it("errs low, so the error is ours and never the customer's", () => {
		// 60s of typical 128 kbps mp3 is ~960 KB. Priced at 320 kbps it reads as
		// 24s — an under-charge, which is the direction a guess should fail in.
		expect(estimateAudioSeconds(960_000, "audio/mpeg")).toBeLessThan(60)
	})

	it("never returns zero for a file that exists", () => {
		expect(estimateAudioSeconds(1, "audio/webm")).toBe(1)
		expect(estimateAudioSeconds(0, "audio/webm")).toBe(1)
	})

	it("assumes the densest compressed format for a container it does not know", () => {
		expect(estimateAudioSeconds(400_000, "audio/basic")).toBe(10)
	})
})
