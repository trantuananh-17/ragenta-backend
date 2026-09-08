import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm"

import { db } from "../../db/client"
import { providerError } from "../../db/schema"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"

const log = logger.child({ module: "observability" })

/** A provider's error page is not a log line. */
const MAX_MESSAGE = 1_000

export interface RecordedProviderError {
	workspaceId?: string | null
	provider: string
	model?: string | null
	operation: "chat" | "embedding" | "rerank" | "ingestion" | "agent" | "speech" | "vision"
	status?: number | null
	message: string
	durationMs?: number | null
}

export const errorLogService = {
	/**
	 * Records a failed provider call.
	 *
	 * **Best effort, always.** This is called from a `catch` that is already
	 * handling somebody's failed request; making that request fail a second way
	 * because the log write did would turn a recoverable provider hiccup into an
	 * outage. The failure to log is itself logged and dropped.
	 */
	async record(entry: RecordedProviderError): Promise<void> {
		try {
			await db.insert(providerError).values({
				id: newId(),
				organizationId: entry.workspaceId ?? null,
				provider: entry.provider,
				model: entry.model ?? null,
				operation: entry.operation,
				status: entry.status ?? null,
				message: entry.message.slice(0, MAX_MESSAGE),
				durationMs: entry.durationMs ?? null,
			})
		} catch (error) {
			log.warn("observability.error_log_failed", { error: String(error) })
		}
	},

	/** The platform view: what has been failing, newest first. */
	async listRecent(from: Date, to: Date, limit: number) {
		return db
			.select()
			.from(providerError)
			.where(and(gte(providerError.createdAt, from), lt(providerError.createdAt, to)))
			.orderBy(desc(providerError.createdAt))
			.limit(limit)
	},

	/**
	 * How often each provider and operation is failing.
	 *
	 * Grouped in SQL rather than counted in Node, for the reason the spend
	 * aggregate is (ADR-051): this table grows with what is wrong, and the days
	 * when it is largest are exactly the days somebody is reading it.
	 */
	async summarise(from: Date, to: Date) {
		return db
			.select({
				provider: providerError.provider,
				operation: providerError.operation,
				status: providerError.status,
				failures: sql<number>`count(*)::int`,
				lastAt: sql<string>`max(${providerError.createdAt})::text`,
			})
			.from(providerError)
			.where(and(gte(providerError.createdAt, from), lt(providerError.createdAt, to)))
			.groupBy(providerError.provider, providerError.operation, providerError.status)
			.orderBy(sql`count(*) desc`)
	},

	/** One workspace's own failures, for a screen a customer sees. */
	async listForWorkspace(workspaceId: string, limit: number) {
		return db
			.select()
			.from(providerError)
			.where(eq(providerError.organizationId, workspaceId))
			.orderBy(desc(providerError.createdAt))
			.limit(limit)
	},

	/**
	 * Deletes failures older than the retention window, a bounded batch at a time.
	 *
	 * Bounded because the first sweep after this ships has years of rows behind it
	 * on a busy deployment, and one unbounded `delete` would hold a lock over the
	 * table the admin console reads. The sweep runs daily and simply takes several
	 * days to catch up, which costs nothing — nobody is waiting on it.
	 *
	 * Zero days disables it entirely: the escape hatch for an incident nobody
	 * wants trimmed out from under them mid-investigation.
	 */
	async pruneOlderThan(days: number, batch: number): Promise<number> {
		if (days <= 0) return 0

		const cutoff = new Date(Date.now() - days * 86_400_000)
		const doomed = db
			.select({ id: providerError.id })
			.from(providerError)
			.where(lt(providerError.createdAt, cutoff))
			.limit(batch)

		const deleted = await db
			.delete(providerError)
			.where(inArray(providerError.id, doomed))
			.returning({ id: providerError.id })

		return deleted.length
	},
}
