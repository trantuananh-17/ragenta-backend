/**
 * Phase 1 image acceptance tests, against a real provider.
 *
 * The unit suite proves the parts that are pure. This proves the part that is
 * not: that an image actually reaches a model in a shape it accepts, and that
 * what comes back parses into the stored extraction. Until this has been run
 * once, the adapters' image mapping has never met a real provider — which is
 * the largest unverified thing in the image work.
 *
 * It touches NO database, NO Redis and NO object storage on purpose, so it can
 * be run against nothing but a key. That is also its limit: it does not test
 * upload, binding, workspace scoping or billing, all of which need a running
 * deployment.
 *
 *   pnpm tsx scripts/smoke-image.ts <image> [more images...] [--ask "question"]
 *
 * Reads OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY from the
 * environment and uses the first one it finds. Override the choice with
 * SMOKE_PROVIDER and SMOKE_MODEL.
 *
 * Every call it makes is billed by the provider. It makes two per image.
 */
import { Buffer } from "node:buffer"
import { readFile } from "node:fs/promises"
import { basename } from "node:path"

import { MODELS } from "../src/ai/models"
import { PROVIDER_DESCRIPTORS } from "../src/ai/clients"
import type { ChatMessage, ProviderClient } from "../src/ai/clients"
import { validateImageUpload, sniffImageMimeType } from "../src/modules/attachment/validate"
import { normalizeExtraction } from "../src/modules/vision/normalize"
import { SYSTEM_PROMPT, USER_PROMPT } from "../src/modules/vision/vision-ocr.provider"

const KEY_BY_PROVIDER: Record<string, string | undefined> = {
	openai: process.env.OPENAI_API_KEY,
	anthropic: process.env.ANTHROPIC_API_KEY,
	google: process.env.GOOGLE_API_KEY,
}

function fail(message: string): never {
	console.error(`\n  FAILED  ${message}\n`)
	process.exit(1)
}

function parseArgs(argv: string[]): { images: string[]; question: string } {
	const images: string[] = []
	let question = "What is in this image? Answer in two sentences."

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]
		if (arg === "--ask") {
			const next = argv[index + 1]
			if (!next) fail("--ask needs a question after it.")
			question = next
			index++
		} else if (arg !== undefined) {
			images.push(arg)
		}
	}
	return { images, question }
}

function pickProvider(): { provider: string; apiKey: string; client: ProviderClient } {
	const wanted = process.env.SMOKE_PROVIDER
	const candidates = wanted ? [wanted] : Object.keys(KEY_BY_PROVIDER)

	for (const provider of candidates) {
		const apiKey = KEY_BY_PROVIDER[provider]
		if (!apiKey) continue
		const client = PROVIDER_DESCRIPTORS.find((entry) => entry.id === provider)?.client
		if (!client?.chat) continue
		if (!client.supportsVision) continue
		return { provider, apiKey, client }
	}

	fail(
		wanted
			? `SMOKE_PROVIDER=${wanted} has no key set, no chat adapter, or no vision support.`
			: "Set OPENAI_API_KEY, ANTHROPIC_API_KEY or GOOGLE_API_KEY first.",
	)
}

function pickModel(provider: string): string {
	const override = process.env.SMOKE_MODEL
	if (override) return override

	// The catalogue is the same one the product resolves from, so a model that
	// works here is a model a workspace can actually select.
	const entry = MODELS.find(
		(model) => model.provider === provider && model.capability === "chat" && model.vision,
	)
	if (!entry) fail(`No vision-capable chat model is declared for ${provider} in src/ai/models.ts.`)
	return entry.model
}

/** Test 4, on a real file rather than a fixture: what the upload boundary would decide. */
function checkValidation(bytes: Buffer) {
	const image = validateImageUpload(bytes)
	console.log(`  validation   ${image.mimeType}  ${bytes.length} bytes  ${image.width ?? "?"}x${image.height ?? "?"}`)
	return image
}

async function main() {
	const { images, question } = parseArgs(process.argv.slice(2))
	if (images.length === 0) {
		console.error("usage: pnpm tsx scripts/smoke-image.ts <image> [...] [--ask \"question\"]")
		console.error("\nSuggested coverage — one image for each acceptance test:")
		console.error("  test 1  an image containing text      (a receipt, a screenshot of prose)")
		console.error("  test 2  an image containing a table   (an invoice, a spreadsheet capture)")
		console.error("  test 3  an ordinary photo             (no document structure at all)")
		process.exit(2)
	}

	const { provider, apiKey, client } = pickProvider()
	const model = pickModel(provider)
	const credential = { apiKey }
	console.log(`provider ${provider}   model ${model}\n`)

	// Test 4 first, and without a network call: a payload that is not an image
	// must be refused by its bytes, whatever it claims to be.
	const notAnImage = Buffer.from("<script>alert(1)</script>", "utf8")
	if (sniffImageMimeType(notAnImage) !== undefined) {
		fail("test 4: a script payload was accepted as an image.")
	}
	try {
		validateImageUpload(notAnImage)
		fail("test 4: validateImageUpload accepted a non-image.")
	} catch {
		console.log("test 4  a non-image payload is refused by signature      PASS\n")
	}

	let failures = 0

	for (const path of images) {
		const label = basename(path)
		console.log(`─── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`)

		const bytes = await readFile(path)
		const image = checkValidation(bytes)
		const dataBase64 = bytes.toString("base64")

		// Tests 1 and 2 — the real OCR prompt, the real normaliser.
		const ocrMessages: ChatMessage[] = [
			{ role: "system", content: SYSTEM_PROMPT },
			{
				role: "user",
				content: USER_PROMPT,
				images: [{ mediaType: image.mimeType, dataBase64 }],
			},
		]

		const started = Date.now()
		const ocr = await client.chat?.(credential, { model, messages: ocrMessages, maxTokens: 4000 })
		if (!ocr) fail("the provider client has no chat method.")

		const extraction = normalizeExtraction(ocr.text, { provider, model })
		const elapsed = Date.now() - started

		console.log(`  ocr          ${elapsed}ms  in ${ocr.usage.inputTokens} / out ${ocr.usage.outputTokens} tokens`)
		console.log(`  text         ${extraction.text.length} chars`)
		console.log(`  tables       ${extraction.tables.length}`)
		console.log(`  fields       ${Object.keys(extraction.fields).length}`)

		const preview = extraction.text.replace(/\s+/g, " ").slice(0, 160)
		console.log(`  preview      ${preview || "(empty)"}`)

		// A normaliser that degraded to raw text is the failure this catches: the
		// text is non-empty either way, so only the shape tells them apart.
		const degraded = extraction.text.trimStart().startsWith("{")
		if (degraded) {
			console.log("  test 1       PARSE DEGRADED — the reply was not usable JSON      FAIL")
			failures++
		} else if (extraction.text.length === 0) {
			console.log("  test 1       no text extracted                                   FAIL")
			failures++
		} else {
			console.log("  test 1       text extracted and normalised                       PASS")
		}

		if (extraction.tables.length > 0) {
			console.log(`  test 2       ${extraction.tables.length} table(s) as HTML                              PASS`)
		} else {
			console.log("  test 2       no table found (expected for a non-table image)     SKIP")
		}

		// Test 3 — general visual understanding, the other half of the feature.
		const answer = await client.chat?.(credential, {
			model,
			messages: [
				{ role: "user", content: question, images: [{ mediaType: image.mimeType, dataBase64 }] },
			],
			maxTokens: 500,
		})
		if (answer && answer.text.trim().length > 0) {
			console.log(`  test 3       answered in ${answer.text.trim().length} chars                            PASS`)
			console.log(`  answer       ${answer.text.replace(/\s+/g, " ").slice(0, 160)}`)
		} else {
			console.log("  test 3       the model returned nothing                          FAIL")
			failures++
		}
		console.log("")
	}

	if (failures > 0) fail(`${failures} check(s) failed.`)
	console.log("all checks passed\n")
}

await main()
