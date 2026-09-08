import { isAppError } from "../../../shared/errors"
import { visionService } from "../../vision/vision.service"
import { loadImageAttachment } from "./image-attachment"
import { collapseVisionUsage, imageOcrParameters, renderExtraction } from "./image-content"
import type { AgentTool, ToolContext, ToolResult } from "./types"

/**
 * Read a document image: transcription, tables and labelled values.
 *
 * A thin pass-through to `visionService.extractDocument` on purpose. The
 * extraction, the provider choice and the field pass are the vision module's,
 * so chat and an agent run get the same answer from the same code, and a Phase 3
 * OCR sidecar reaches this tool without it changing (ADR-035/036).
 */
export const imageOcrTool: AgentTool = {
	name: "image_ocr",
	description:
		"Read an image attachment as a document: its full text, any tables in it, and labelled values such as an invoice's totals. Use it for a scan, a receipt, a form or a screenshot of a document, when you need what the image says rather than what it looks like. Give it the attachment id.",
	parameters: imageOcrParameters,
	writes: false,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = imageOcrParameters.parse(args)

		const loaded = await loadImageAttachment(context, input.attachmentId)
		if (!loaded.ok) return loaded.refusal

		// An image is immutable once stored — the key is generated from the row's
		// id and nothing overwrites it — so a stored extraction can only be the
		// same answer this call would produce. Re-running it would bill the
		// workspace a second time for it, and no usage is reported here because
		// none was spent. (The cache is written by whoever first extracts and
		// persists; this tool does not write it back, so an agent-only extraction
		// still costs once per run.)
		const cached = loaded.row.extracted
		if (cached) {
			return {
				ok: true,
				content: renderExtraction(cached),
				metadata: {
					attachmentId: input.attachmentId,
					cached: true,
					characters: cached.text.length,
					tables: cached.tables.length,
					fields: Object.keys(cached.fields).length,
					provider: cached.metadata.provider,
					model: cached.metadata.model ?? null,
				},
			}
		}

		try {
			const outcome = await visionService.extractDocument({
				workspaceId: context.workspaceId,
				image: loaded.image,
				// The transcription pass only. `extractDocument` keeps the field pass
				// on the workspace's chat model, because that one reads text.
				model: context.model,
				signal: context.signal,
			})

			const charge = collapseVisionUsage(outcome.usage)
			return {
				ok: true,
				content: renderExtraction(outcome.extraction),
				metadata: {
					attachmentId: input.attachmentId,
					cached: false,
					characters: outcome.extraction.text.length,
					tables: outcome.extraction.tables.length,
					fields: Object.keys(outcome.extraction.fields).length,
					provider: outcome.extraction.metadata.provider,
					model: outcome.extraction.metadata.model ?? null,
					// Every pass, per model — the ledger row can only carry one, so
					// this is where the full spend stays visible on the timeline.
					passes: outcome.usage,
				},
				usage: charge ? { ...charge, operation: "agent" } : undefined,
			}
		} catch (error) {
			// A workspace with no vision-capable model, or a provider that refused,
			// arrives here as a domain error. Its message already says what is
			// wrong in words the model can act on.
			return {
				ok: false,
				content: isAppError(error) ? error.message : "That image could not be read.",
				metadata: { attachmentId: input.attachmentId, error: "extract_failed" },
			}
		}
	},
}
