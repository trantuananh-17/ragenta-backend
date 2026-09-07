import { describe, expect, it } from "vitest"

import { endpointStatus, resolveEndpoint } from "./resolve"

/**
 * The rule that decides which key gets posted to which host. It is tested on
 * its own because getting it wrong is not a crash: it is a working-looking
 * deployment that sends one provider's credential to another provider's server.
 */

const ENV_STT = {
	baseUrl: "https://api.openai.com/v1",
	apiKey: "sk-env-key-000000",
	model: "whisper-1",
}

const ENV_TTS = { ...ENV_STT, model: "tts-1", voice: "alloy" }

const DB_STT = {
	baseUrl: "https://openrouter.ai/api/v1",
	apiKey: "sk-or-db-key-111111",
	model: "openai/whisper-large-v3",
	voice: null,
}

describe("resolveEndpoint", () => {
	it("prefers a complete database row over the environment", () => {
		const resolved = resolveEndpoint("stt", DB_STT, ENV_STT)
		expect(resolved).toEqual({
			baseUrl: DB_STT.baseUrl,
			apiKey: DB_STT.apiKey,
			model: DB_STT.model,
			source: "database",
		})
	})

	it("falls back to the environment when nothing is stored", () => {
		expect(resolveEndpoint("stt", undefined, ENV_STT)?.source).toBe("environment")
	})

	it("is undefined when neither source has it", () => {
		expect(resolveEndpoint("stt", undefined, undefined)).toBeUndefined()
	})

	/*
		The property that matters most here. A half-written row must not borrow the
		missing pieces from the environment: that is how an OpenRouter key ends up
		posted to api.openai.com, which fails as a 401 that reads like a bad key
		rather than like a mixed configuration.
	*/
	it("does not mix a partial database row with the environment", () => {
		for (const partial of [
			{ ...DB_STT, apiKey: null },
			{ ...DB_STT, baseUrl: null },
			{ ...DB_STT, model: null },
		]) {
			const resolved = resolveEndpoint("stt", partial, ENV_STT)
			expect(resolved).toEqual({ ...ENV_STT, source: "environment" })
		}
	})

	it("refuses synthesis without a voice, from either source", () => {
		const storedWithoutVoice = { ...DB_STT, model: "tts-model", voice: null }
		expect(resolveEndpoint("tts", storedWithoutVoice, undefined)).toBeUndefined()

		const { voice: _dropped, ...envWithoutVoice } = ENV_TTS
		expect(resolveEndpoint("tts", storedWithoutVoice, envWithoutVoice)).toBeUndefined()
	})

	it("carries the voice through for synthesis", () => {
		const stored = { ...DB_STT, model: "gemini-tts", voice: "vi-VN-Wavenet-A" }
		expect(resolveEndpoint("tts", stored, ENV_TTS)).toMatchObject({
			voice: "vi-VN-Wavenet-A",
			source: "database",
		})
	})

	it("takes no voice from a transcription endpoint", () => {
		const stored = { ...DB_STT, voice: "alloy" }
		expect(resolveEndpoint("stt", stored, ENV_STT)).not.toHaveProperty("voice")
	})
})

describe("endpointStatus", () => {
	it("shows the stored hint only when the stored row is the one in use", () => {
		const fromDatabase = resolveEndpoint("stt", DB_STT, ENV_STT)
		expect(endpointStatus(fromDatabase, "sk-••••1111").keyHint).toBe("sk-••••1111")
	})

	it("shows no hint for an environment key, which has none", () => {
		const fromEnv = resolveEndpoint("stt", undefined, ENV_STT)
		expect(endpointStatus(fromEnv, "sk-••••1111")).toMatchObject({
			configured: true,
			source: "environment",
			keyHint: null,
		})
	})

	it("reports an unconfigured half without inventing values", () => {
		expect(endpointStatus(undefined, null)).toEqual({
			configured: false,
			source: null,
			baseUrl: null,
			model: null,
			voice: null,
			keyHint: null,
		})
	})
})
