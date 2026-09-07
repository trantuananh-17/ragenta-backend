/**
 * Phase 2 audio acceptance tests, against a real speech service.
 *
 * The unit suite proves the request shapes and the pricing arithmetic. This
 * proves the part it cannot: that a real recording comes back as words, and
 * that real text comes back as audio a person can play.
 *
 * It touches NO database, NO Redis and NO object storage, so it runs against
 * nothing but a key. It therefore does not test upload, attachment binding,
 * workspace scoping or billing — those need a running deployment.
 *
 *   pnpm tsx scripts/smoke-speech.ts [recording.webm] [--say "text"] [--out out.mp3]
 *
 * Configuration, in order of preference:
 *   SPEECH_STT_BASE_URL / SPEECH_STT_API_KEY / SPEECH_STT_MODEL
 *   SPEECH_TTS_BASE_URL / SPEECH_TTS_API_KEY / SPEECH_TTS_MODEL / SPEECH_TTS_VOICE
 * falling back to OPENAI_API_KEY against api.openai.com.
 *
 * Point the SPEECH_* variables at a speaches container or the VieNeu shim to run
 * exactly the same checks against the self-hosted path.
 *
 * Every call it makes is billed by whoever serves it.
 */
import { Buffer } from "node:buffer"
import { readFile, writeFile } from "node:fs/promises"
import { basename } from "node:path"

import { createSpeechToText, createTextToSpeech } from "../src/ai/speech/openai-compatible"
import { MAX_AUDIO_BYTES } from "../src/ai/speech/types"
import { sniffAudioMimeType, validateAudioUpload } from "../src/modules/attachment/validate"

/** Vietnamese on purpose: it is the language this feature exists for, and the
 * one where a wrong tone changes the word rather than the accent. */
const DEFAULT_SAY = "Xin chào, đây là bản thử giọng nói tiếng Việt của Ragenta."

const OPENAI = "https://api.openai.com/v1"

function fail(message: string): never {
	console.error(`\n  FAILED  ${message}\n`)
	process.exit(1)
}

function parseArgs(argv: string[]): { audio?: string; say: string; out: string } {
	let audio: string | undefined
	let say = DEFAULT_SAY
	let out = "smoke-speech.mp3"

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]
		if (arg === "--say") {
			const next = argv[index + 1]
			if (!next) fail("--say needs text after it.")
			say = next
			index++
		} else if (arg === "--out") {
			const next = argv[index + 1]
			if (!next) fail("--out needs a path after it.")
			out = next
			index++
		} else if (arg !== undefined) {
			audio = arg
		}
	}
	return { audio, say, out }
}

const env = process.env

function sttEndpoint() {
	const apiKey = env.SPEECH_STT_API_KEY ?? env.OPENAI_API_KEY
	if (!apiKey) return undefined
	return {
		id: "smoke-stt",
		baseUrl: env.SPEECH_STT_BASE_URL ?? OPENAI,
		apiKey,
		model: env.SPEECH_STT_MODEL ?? "whisper-1",
	}
}

function ttsEndpoint() {
	const apiKey = env.SPEECH_TTS_API_KEY ?? env.OPENAI_API_KEY
	if (!apiKey) return undefined
	return {
		id: "smoke-tts",
		baseUrl: env.SPEECH_TTS_BASE_URL ?? OPENAI,
		apiKey,
		model: env.SPEECH_TTS_MODEL ?? "tts-1",
	}
}

async function main() {
	const { audio, say, out } = parseArgs(process.argv.slice(2))
	let failures = 0

	// Test 5, offline: a payload that is not audio must be refused by its bytes,
	// whatever it claims to be. Also the cross-format check that matters — a WAV
	// and a WebP both begin `RIFF`.
	const notAudio = Buffer.from("<script>alert(1)</script>", "utf8")
	if (sniffAudioMimeType(notAudio) !== undefined) fail("test 5: a script payload sniffed as audio.")
	const webp = Buffer.concat([
		Buffer.from("RIFF", "ascii"),
		Buffer.alloc(4),
		Buffer.from("WEBP", "ascii"),
	])
	if (sniffAudioMimeType(webp) !== undefined) fail("test 5: a WebP image sniffed as audio.")
	console.log("test 5  non-audio and RIFF/WEBP are both refused            PASS\n")

	// Test 1 — a real recording becomes words.
	if (!audio) {
		console.log("test 1  SKIPPED — pass a recording to transcribe")
		console.log("        e.g. pnpm tsx scripts/smoke-speech.ts note.webm\n")
	} else {
		const endpoint = sttEndpoint()
		if (!endpoint) fail("Set SPEECH_STT_API_KEY or OPENAI_API_KEY to transcribe.")

		const bytes = await readFile(audio)
		if (bytes.length > MAX_AUDIO_BYTES) fail(`${basename(audio)} is over the ${MAX_AUDIO_BYTES}-byte cap.`)

		const validated = validateAudioUpload(bytes)
		console.log(`─── ${basename(audio)}`)
		console.log(`  sniffed      ${validated.mimeType}  ${bytes.length} bytes`)

		const stt = createSpeechToText(endpoint)
		const started = Date.now()
		const result = await stt.transcribe({
			audio: bytes,
			mimeType: validated.mimeType,
			fileName: basename(audio),
			// Forced rather than detected: this is the Vietnamese acceptance test,
			// and auto-detection on a short clip is the usual way it silently
			// becomes a different language's transcript.
			language: "vi",
		})
		const elapsed = Date.now() - started

		console.log(`  stt          ${elapsed}ms  model ${endpoint.model}  via ${endpoint.baseUrl}`)
		console.log(`  language     ${result.language ?? "(not reported)"}`)
		console.log(`  duration     ${result.durationSec ?? "(not reported)"}`)
		console.log(`  segments     ${result.segments.length}`)
		console.log(`  transcript   ${result.text.slice(0, 200) || "(empty)"}`)

		if (result.text.trim().length > 0) {
			console.log("  test 1       speech became words                                PASS\n")
		} else {
			console.log("  test 1       the service returned no text                       FAIL\n")
			failures++
		}

		// Duration is what STT is billed on, so an absent one is worth saying out
		// loud rather than discovering as a zero-credit ledger row.
		if (result.durationSec === undefined) {
			console.log("  note         this service reports no duration — STT would bill 0\n")
		}
	}

	// Test 3 — text becomes Vietnamese audio.
	const ttsConfig = ttsEndpoint()
	if (!ttsConfig) {
		console.log("test 3  SKIPPED — set SPEECH_TTS_API_KEY or OPENAI_API_KEY")
	} else {
		const voice = env.SPEECH_TTS_VOICE ?? "alloy"
		const tts = createTextToSpeech(ttsConfig)
		const started = Date.now()
		const spoken = await tts.synthesize({ text: say, voice, format: "mp3" })
		const elapsed = Date.now() - started

		await writeFile(out, spoken.audio)
		console.log(`─── synthesis`)
		console.log(`  tts          ${elapsed}ms  model ${ttsConfig.model}  voice ${voice}`)
		console.log(`  said         ${say}`)
		console.log(`  wrote        ${out}  ${spoken.audio.length} bytes  ${spoken.mimeType}`)

		if (spoken.audio.length > 0) {
			console.log("  test 3       text became audio                                  PASS")
		} else {
			console.log("  test 3       the service returned no audio                      FAIL")
			failures++
		}
		console.log(`\n  Play ${out} and listen. Vietnamese tone is the thing to judge, and`)
		console.log("  no assertion here can do it — OpenAI's voices read Vietnamese with an")
		console.log("  English accent, which is the reason the VieNeu path exists.\n")
	}

	console.log("test 2  send-the-transcript is the ordinary chat path; covered by the app")
	console.log("test 4  playback start/stop is browser-only and cannot be checked here\n")

	if (failures > 0) fail(`${failures} check(s) failed.`)
	console.log("all runnable checks passed\n")
}

await main()
