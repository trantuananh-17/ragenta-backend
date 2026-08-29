import type { DbExecutor } from "../../db/client"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import type { PaginationQuery } from "../../shared/pagination"
import { page } from "../../shared/pagination"
import { auditRepository } from "./audit.repository"
import type { AuditFilter } from "./audit.repository"

const log = logger.child({ module: "audit" })

export interface AuditEntry {
	action: string
	actorId?: string | null
	organizationId?: string | null
	targetType?: string | null
	targetId?: string | null
	status?: "success" | "failure"
	ipAddress?: string | null
	userAgent?: string | null
	metadata?: Record<string, unknown>
}

function toRow(entry: AuditEntry) {
	return {
		id: newId(),
		action: entry.action,
		actorId: entry.actorId ?? null,
		organizationId: entry.organizationId ?? null,
		targetType: entry.targetType ?? null,
		targetId: entry.targetId ?? null,
		status: entry.status ?? "success",
		ipAddress: entry.ipAddress ?? null,
		userAgent: entry.userAgent ?? null,
		metadata: entry.metadata ?? {},
	}
}

export const auditService = {
	/**
	 * Best effort, for events whose operation has already committed. A failure to
	 * write the trail is logged loudly but never turned into a failed request —
	 * the action the user asked for already happened.
	 */
	async record(entry: AuditEntry): Promise<void> {
		try {
			await auditRepository.insert(toRow(entry))
		} catch (error) {
			log.error("Failed to write audit entry", error, { action: entry.action })
		}
	},

	/**
	 * Writes inside the caller's transaction, so the trail commits with the change
	 * it describes or not at all. Use this for anything that moves money or
	 * permissions; failures propagate on purpose.
	 */
	async recordWithin(executor: DbExecutor, entry: AuditEntry): Promise<void> {
		await auditRepository.insert(toRow(entry), executor)
	},

	async list(filter: AuditFilter, query: PaginationQuery) {
		const { items, total } = await auditRepository.list(filter, query)
		return page(items, total, query)
	},
}
