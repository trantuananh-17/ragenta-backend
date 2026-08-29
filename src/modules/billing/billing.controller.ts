import type { AppContext } from "../../api/types"
import { requireMembership, requireUser } from "../../api/types"
import { isStripeConfigured } from "../../payments/stripe"
import { ValidationError } from "../../shared/errors"
import { paginationQuerySchema } from "../../shared/pagination"
import { autoReloadService } from "./autoreload.service"
import { billingService } from "./billing.service"
import { createCheckoutSchema, updateAutoReloadSchema } from "./billing.dto"
import { isPlanName, isTopupPackId } from "./plans"
import { stripeService } from "./stripe.service"

/** Every payment route answers the same way when the deployment has no Stripe keys. */
function assertPaymentsEnabled() {
	if (!isStripeConfigured()) {
		throw new ValidationError("Payments are not enabled on this deployment.")
	}
}

export const billingController = {
	async summary(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(await billingService.getSummary(membership.organizationId))
	},

	async transactions(c: AppContext) {
		const membership = requireMembership(c)
		const query = paginationQuerySchema.parse(c.req.query())
		return c.json(await billingService.listTransactions(membership.organizationId, query))
	},

	async createCheckout(c: AppContext) {
		assertPaymentsEnabled()
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = createCheckoutSchema.parse(await c.req.json())

		// The signed-in owner or admin is who Stripe will invoice and email.
		const session =
			input.plan && isPlanName(input.plan)
				? await stripeService.createPlanCheckout(
						membership.organizationId,
						input.plan,
						user.id,
						user.email,
					)
				: input.pack && isTopupPackId(input.pack)
					? await stripeService.createTopupCheckout(
							membership.organizationId,
							input.pack,
							user.id,
							user.email,
						)
					: null

		if (!session) throw new ValidationError("Unknown plan or top-up pack.")
		return c.json(session)
	},

	async createPortal(c: AppContext) {
		assertPaymentsEnabled()
		const user = requireUser(c)
		const membership = requireMembership(c)
		return c.json(
			await stripeService.createPortalSession(membership.organizationId, user.email),
		)
	},

	async getAutoReload(c: AppContext) {
		const membership = requireMembership(c)
		return c.json(await autoReloadService.get(membership.organizationId))
	},

	async updateAutoReload(c: AppContext) {
		assertPaymentsEnabled()
		const user = requireUser(c)
		const membership = requireMembership(c)
		const input = updateAutoReloadSchema.parse(await c.req.json())
		return c.json(
			await autoReloadService.update(membership.organizationId, input, user.id),
		)
	},
}
