import { db } from "../../db/client"
import { EntitlementError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import type { PaginationQuery } from "../../shared/pagination"
import { page } from "../../shared/pagination"
import { billingService } from "../billing/billing.service"
import type { CreditSource } from "../billing/billing.service"
import { planLimits } from "../billing/plans"
import { listModels, modelTier, priceUsage } from "./pricing"
import { usageRepository } from "./usage.repository"
import type { UsageFilter } from "./usage.repository"

const log = logger.child({ module: "usage" })

export type UsageOperation = "chat" | "embedding" | "rerank" | "ingestion" | "agent"

/** Which credit source an operation is charged against. */
const OPERATION_SOURCE: Record<UsageOperation, CreditSource> = {
	chat: "chat",
	embedding: "embedding",
	rerank: "chat",
	ingestion: "ingestion",
	agent: "agent",
}

export interface RecordUsageInput {
	workspaceId: string
	projectId?: string | null
	userId?: string | null
	operation: UsageOperation
	provider: string
	model: string
	inputTokens?: number
	outputTokens?: number
	embeddingTokens?: number
	/**
	 * Idempotency key for the whole charge — a message id, a job id, a provider
	 * request id. Must be stable across retries of the same logical operation.
	 */
	reference: string
	metadata?: Record<string, unknown>
}

export const usageService = {
	/**
	 * Entitlement gate for model choice. Must be called **before** a provider
	 * request, not after: charging correctly for a call the plan never allowed is
	 * still a call we paid for.
	 *
	 * This is what keeps the free tier from costing money — free workspaces are
	 * economy models only, which is also why every embedding model is economy.
	 */
	async assertModelAllowed(workspaceId: string, provider: string, model: string) {
		const plan = await billingService.getPlan(workspaceId)
		const tier = modelTier(provider, model)

		if (!planLimits(plan).modelTiers.includes(tier)) {
			throw new EntitlementError(
				"MODEL_NOT_IN_PLAN",
				`The ${plan} plan does not include ${model}. Upgrade to use premium models.`,
				{ plan, provider, model, tier },
			)
		}
	},

	/** The model picker's catalogue, with each entry marked available or not. */
	async listAvailableModels(workspaceId: string) {
		const plan = await billingService.getPlan(workspaceId)
		const allowed = planLimits(plan).modelTiers

		return {
			plan,
			models: listModels().map((entry) => ({
				...entry,
				available: allowed.includes(entry.tier),
			})),
		}
	},

	/**
	 * The one entry point the AI layer will call after a provider responds:
	 * prices the tokens, writes the usage row and deducts the credits in a single
	 * transaction.
	 *
	 * Charged from the provider's reported token counts, never an estimate, and
	 * charged *after* the call — a failed provider call bills nothing. The seat
	 * of the "can they afford it" check is before the call, via
	 * `billingService.getSummary`, because refusing mid-stream is worse than
	 * refusing up front.
	 */
	async recordAndCharge(input: RecordUsageInput) {
		const { credits, pricingVersion } = priceUsage(input.provider, input.model, input)

		return db.transaction(async (tx) => {
			// A rounding-to-zero charge still records the usage: the tokens were
			// really consumed, and a spend of 0 is rejected by the ledger.
			const charge =
				credits > 0
					? await billingService.spendWithin(tx, {
							workspaceId: input.workspaceId,
							amount: credits,
							reference: input.reference,
							source: OPERATION_SOURCE[input.operation],
						})
					: { charged: 0, alreadyApplied: false }

			const usage = await usageRepository.insert(
				{
					id: newId(),
					organizationId: input.workspaceId,
					projectId: input.projectId ?? null,
					userId: input.userId ?? null,
					operation: input.operation,
					provider: input.provider,
					model: input.model,
					inputTokens: input.inputTokens ?? 0,
					outputTokens: input.outputTokens ?? 0,
					embeddingTokens: input.embeddingTokens ?? 0,
					credits: credits.toFixed(4),
					pricingVersion,
					reference: input.reference,
					metadata: input.metadata ?? {},
				},
				tx,
			)

			log.info("usage.recorded", {
				workspaceId: input.workspaceId,
				projectId: input.projectId ?? undefined,
				operation: input.operation,
				model: input.model,
				credits,
				alreadyApplied: charge.alreadyApplied || !usage,
			})

			return { credits, pricingVersion, charge, alreadyApplied: !usage }
		})
	},

	async list(workspaceId: string, filter: UsageFilter, query: PaginationQuery) {
		const { items, total } = await usageRepository.list(workspaceId, filter, query)
		return page(items, total, query)
	},

	async summary(workspaceId: string, days: number) {
		const since = new Date(Date.now() - days * 24 * 3600 * 1000)
		const rows = await usageRepository.summarize(workspaceId, since)

		return {
			since,
			days,
			breakdown: rows.map((row) => ({
				operation: row.operation,
				provider: row.provider,
				model: row.model,
				calls: row.calls,
				inputTokens: Number(row.inputTokens ?? 0),
				outputTokens: Number(row.outputTokens ?? 0),
				embeddingTokens: Number(row.embeddingTokens ?? 0),
				credits: Number(row.credits ?? 0),
			})),
			totalCredits: rows.reduce((total, row) => total + Number(row.credits ?? 0), 0),
		}
	},
}
