import { env } from "../../config/env"
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors"
import { newId } from "../../shared/id"
import { logger } from "../../shared/logger"
import { getRedis } from "../../redis/client"
import { agentRepository } from "../agent/agent.repository"
import { auditService } from "../audit/audit.service"
import { billingService } from "../billing/billing.service"
import { PLAN_LIMITS } from "../billing/plans"
import type { PlanName } from "../billing/plans"
import { widgetRepository } from "./widget.repository"
import type { ChatWidgetRow } from "./widget.repository"
import {
	generateWidgetKey,
	newVisitorId,
	originAllowed,
	readVisitorToken,
	signVisitorToken,
} from "./widget-guard"
import type { SaveWidgetInput } from "./widget.dto"

const log = logger.child({ module: "widget" })

/** A visitor is remembered for a month; after that they start a new conversation. */
const VISITOR_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface WidgetVisitor {
	widget: ChatWidgetRow
	visitorId: string
	/** Set when the token was minted this request, so the response can hand it back. */
	issuedToken?: string
}

export const widgetService = {
	async list(workspaceId: string) {
		return (await widgetRepository.list(workspaceId)).map(toPublic)
	},

	/**
	 * Creates or changes a widget.
	 *
	 * The plan limit is checked here rather than at publish time, because a
	 * workspace that downgrades should keep its widgets working until somebody
	 * decides otherwise — taking a customer's chat bubble off their website
	 * because a card expired is a worse failure than one widget too many.
	 */
	async save(workspaceId: string, input: SaveWidgetInput, actorId: string) {
		const existing = input.id
			? await widgetRepository.findScoped(workspaceId, input.id)
			: undefined
		if (input.id && !existing) throw new NotFoundError("Widget")

		if (!existing) {
			const summary = await billingService.getSummary(workspaceId)
			const limit = PLAN_LIMITS[summary.plan as PlanName].widgetLimit
			const held = await widgetRepository.count(workspaceId)

			if (limit !== null && held >= limit) {
				throw new ForbiddenError(
					limit === 0
						? "Embedded chat is not available on the free plan. Upgrade to publish one."
						: `The ${summary.plan} plan includes ${limit} embedded ${limit === 1 ? "chat" : "chats"}. Upgrade, or remove one first.`,
				)
			}
		}

		const agent = await agentRepository.findById(workspaceId, input.agentId)
		if (!agent) throw new NotFoundError("Agent")

		const duplicate = (await widgetRepository.list(workspaceId)).find(
			(row) => row.name === input.name && row.id !== existing?.id,
		)
		if (duplicate) throw new ConflictError(`A widget called "${input.name}" already exists.`)

		const id = existing?.id ?? newId()
		await widgetRepository.upsert({
			id,
			organizationId: workspaceId,
			agentId: agent.id,
			name: input.name,
			enabled: input.enabled,
			// Generated once and never rotated silently: the key is pasted into
			// somebody else's website, and changing it breaks their page.
			publicKey: existing?.publicKey ?? generateWidgetKey(),
			allowedOrigins: input.allowedOrigins,
			greeting: input.greeting,
			accentColor: input.accentColor,
			title: input.title,
			dailyCreditCeiling: input.dailyCreditCeiling.toFixed(4),
			visitorHourlyLimit: input.visitorHourlyLimit,
			createdBy: existing?.createdBy ?? actorId,
		})

		await auditService.record({
			action: "widget.saved",
			actorId,
			organizationId: workspaceId,
			targetType: "chat_widget",
			targetId: id,
			metadata: { name: input.name, origins: input.allowedOrigins, agentId: agent.id },
		})

		const saved = await widgetRepository.findScoped(workspaceId, id)
		return saved ? toPublic(saved) : undefined
	},

	async remove(workspaceId: string, widgetId: string, actorId: string) {
		const existing = await widgetRepository.findScoped(workspaceId, widgetId)
		if (!existing) throw new NotFoundError("Widget")

		await widgetRepository.remove(widgetId)
		await auditService.record({
			action: "widget.removed",
			actorId,
			organizationId: workspaceId,
			targetType: "chat_widget",
			targetId: widgetId,
			metadata: { name: existing.name },
		})
	},

	/**
	 * Who is asking, on the public surface.
	 *
	 * Four refusals, all answered the same way by the caller, because telling a
	 * stranger which one they hit is telling them how to get past it:
	 *
	 *  - the key names no widget
	 *  - the widget is off
	 *  - the request came from an origin the widget is not allowed on
	 *  - the widget has spent its day
	 *
	 * The last one is the only one that is not about identity, and it is the one
	 * that actually caps the money (ADR-065).
	 */
	async resolveVisitor(
		publicKey: string,
		origin: string | undefined,
		presentedToken: string | undefined,
	): Promise<WidgetVisitor> {
		const widget = await widgetRepository.findByKey(publicKey)
		if (!widget || !widget.enabled) throw new NotFoundError("Widget")

		if (!originAllowed(origin, widget.allowedOrigins)) {
			log.warn("widget.origin_refused", { widgetId: widget.id, origin })
			throw new NotFoundError("Widget")
		}

		const existing = readVisitorToken(presentedToken, env.auth.secret, VISITOR_TOKEN_MAX_AGE_MS)

		// A token minted for another widget is treated as no token rather than as
		// an error: the visitor simply gets a new one for this widget.
		if (existing && existing.widgetId === widget.id) {
			return { widget, visitorId: existing.visitorId }
		}

		const visitorId = newVisitorId()
		return {
			widget,
			visitorId,
			issuedToken: signVisitorToken(
				{ widgetId: widget.id, visitorId, issuedAt: Date.now() },
				env.auth.secret,
			),
		}
	},

	/**
	 * The two limits that stand between a public endpoint and a spent wallet.
	 *
	 * Checked **before** the model is called, not after: a refusal that arrives
	 * once the tokens are already bought is not a limit.
	 */
	async assertWithinLimits(widget: ChatWidgetRow, visitorId: string): Promise<void> {
		const spent = await widgetRepository.spentToday(widget.id)
		if (spent >= Number(widget.dailyCreditCeiling)) {
			log.warn("widget.daily_ceiling_reached", { widgetId: widget.id, spent })
			throw new ValidationError(
				"This chat has reached today's limit. Please try again tomorrow, or contact us another way.",
			)
		}

		// Per visitor rather than per address: several people behind one office
		// NAT are one address and should not lock each other out, which is the same
		// reasoning ADR-045 applies to authenticated routes.
		const key = `widget:rate:${widget.id}:${visitorId}`
		try {
			const redis = getRedis()
			const used = await redis.incr(key)
			if (used === 1) await redis.expire(key, 3_600)
			if (used > widget.visitorHourlyLimit) {
				throw new ValidationError("You have sent a lot of messages. Please try again shortly.")
			}
		} catch (error) {
			if (error instanceof ValidationError) throw error
			// Redis down. Unlike ADR-045's limiter this does **not** fail open on its
			// own — but the daily ceiling above is a database read and still holds,
			// so the money is capped even while the pace is not.
			log.warn("widget.rate_limit_unavailable", { widgetId: widget.id, error: String(error) })
		}
	},

	/**
	 * What one widget has been doing, for the workspace that owns it.
	 *
	 * Credits only — never the provider cost. What the workspace was charged is
	 * theirs to see; what we paid the provider is our margin, and it belongs on
	 * the admin console's revenue report and nowhere a customer can read it.
	 *
	 * Today's spend against the ceiling travels with it, because "why did my chat
	 * stop answering" is the question this screen exists to answer and the ceiling
	 * is the most common reason.
	 */
	async usage(workspaceId: string, widgetId: string, from: Date, to: Date, limit: number) {
		const widget = await widgetRepository.findScoped(workspaceId, widgetId)
		if (!widget) throw new NotFoundError("Widget")

		const [totals, daily, recent, spentToday] = await Promise.all([
			widgetRepository.usageTotals(widgetId, from, to),
			widgetRepository.dailyUsage(widgetId, from, to),
			widgetRepository.recentRuns(widgetId, from, to, limit),
			widgetRepository.spentToday(widgetId),
		])

		return {
			range: { from: from.toISOString(), to: to.toISOString() },
			widget: { id: widget.id, name: widget.name, enabled: widget.enabled },
			today: {
				spent: spentToday,
				ceiling: Number(widget.dailyCreditCeiling),
			},
			totals,
			daily,
			recent,
		}
	},

	/** What the embed page needs to render before anybody types anything. */
	toEmbedConfig(widget: ChatWidgetRow) {
		return {
			title: widget.title,
			greeting: widget.greeting,
			accentColor: widget.accentColor,
		}
	},
}

/** The public key is returned here — it is publishable, and the screen has to show it. */
function toPublic(row: ChatWidgetRow) {
	return {
		id: row.id,
		agentId: row.agentId,
		name: row.name,
		enabled: row.enabled,
		publicKey: row.publicKey,
		allowedOrigins: row.allowedOrigins,
		greeting: row.greeting,
		accentColor: row.accentColor,
		title: row.title,
		dailyCreditCeiling: Number(row.dailyCreditCeiling),
		visitorHourlyLimit: row.visitorHourlyLimit,
		createdAt: row.createdAt,
	}
}
