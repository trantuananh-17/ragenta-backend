import type { AttachmentExtraction } from "../../db/schema/attachment.schema"
import type { ModelSelection } from "../model/model.service"

/** Bytes to look at, in the shape `ImagePart` already uses on the wire. */
export interface ImageInput {
	/** Raw base64, with no `data:` prefix. */
	dataBase64: string
	/** IANA type of those bytes: image/png, image/jpeg, image/webp. */
	mimeType: string
}

/**
 * One file to extract from.
 *
 * `fileName` is display and logging only — the storage key is generated from the
 * attachment's id, and a name that reached a path would be attacker-controlled.
 */
export interface OcrInput extends ImageInput {
	fileName?: string
}

/**
 * What an OCR provider is allowed to know about the caller.
 *
 * Deliberately small, and the same rule agent tools follow: a workspace, and at
 * most which model to run. No session, no request, no database handle — anything
 * a provider needs beyond this belongs to a domain service that does its own
 * workspace scoping (`.claude/rules/security.md`).
 */
export interface OcrContext {
	workspaceId: string
	/**
	 * Which model to run. Meaningful only to a provider that runs one — a
	 * dedicated OCR engine ignores it, which is why it is optional here rather
	 * than required and stubbed there.
	 */
	model?: ModelSelection
	signal?: AbortSignal
}

/**
 * Provider spend one extraction caused, for the **caller** to charge.
 *
 * Returned rather than recorded, exactly as `ToolResult.usage` is: the same call
 * is a chat turn from the composer, an agent step inside a run, and an ingestion
 * job in the worker, and only the caller knows which — so only the caller can
 * give the charge its operation and its idempotency reference.
 */
export interface VisionUsage {
	provider: string
	model: string
	inputTokens: number
	outputTokens: number
}

export interface OcrOutcome {
	extraction: AttachmentExtraction
	/**
	 * Absent when the extraction cost no provider tokens. A self-hosted engine
	 * running on Ragenta's own CPU has nothing to bill per call, and reporting
	 * zeroes would put rows in the usage ledger that describe nothing.
	 */
	usage?: VisionUsage
}

/**
 * Structured extraction from a document image, behind one interface.
 *
 * **Nothing on this interface may assume a language model produced the result.**
 * The first implementation is vision-model-based (`vision-ocr.provider.ts`)
 * because it needs no infrastructure Ragenta does not already run, but Phase 3
 * adds a PaddleOCR PP-StructureV3 CPU sidecar as a second implementation, and
 * that swap must be a registration change rather than a rewrite. So: the input
 * is bytes and a media type, the context carries no prompt and no message
 * history, the output is the stored `AttachmentExtraction` shape, and `usage` is
 * optional. A sidecar implements this by POSTing the bytes to its own HTTP
 * endpoint and mapping the response — it never touches `context.model`, never
 * returns `usage`, and fills in `metadata.meanConfidence`, which a language
 * model cannot.
 */
export interface OcrProvider {
	readonly id: string
	extract(input: OcrInput, context: OcrContext): Promise<OcrOutcome>
}
