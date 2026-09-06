import type { MessageCitation } from "../../db/schema"
import type { RetrievedChunk } from "../retrieval/retrieval.service"

/**
 * The passages one run has seen, numbered once across the whole run.
 *
 * A tool-using agent searches more than once, and if each search numbered its
 * own results from 1 then `[[1]]` would mean a different passage depending on
 * which search the model was thinking of — and the answer's citations would
 * point at the wrong sources. So the numbering belongs to the run, not to the
 * call, and this is what owns it.
 *
 * A passage returned twice keeps its first number: re-numbering it would leave
 * the model with two markers for one paragraph, and the second search returning
 * the same top result is the normal case, not an edge one.
 */
export class CitationCollector {
	private readonly byChunkId = new Map<string, MessageCitation>()

	/** Adds passages and returns them numbered, in the order given. */
	add(chunks: RetrievedChunk[]): MessageCitation[] {
		const added: MessageCitation[] = []

		for (const chunk of chunks) {
			const existing = this.byChunkId.get(chunk.chunkId)
			if (existing) {
				added.push(existing)
				continue
			}

			const citation: MessageCitation = {
				index: this.byChunkId.size + 1,
				chunkId: chunk.chunkId,
				documentId: chunk.documentId,
				documentName: chunk.documentName,
				snippet: chunk.content.slice(0, 400),
				score: Number(chunk.score.toFixed(4)),
				kind: chunk.kind,
				fromPage: chunk.fromPage,
				toPage: chunk.toPage,
			}
			this.byChunkId.set(chunk.chunkId, citation)
			added.push(citation)
		}

		return added
	}

	all(): MessageCitation[] {
		return [...this.byChunkId.values()].sort((a, b) => a.index - b.index)
	}

	get size(): number {
		return this.byChunkId.size
	}
}
