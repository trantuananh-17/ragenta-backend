import { modelKey } from "../../ai/models"
import type { ModelDefinition } from "../../ai/models"
import { planLimits } from "../billing/plans"
import type { PlanName } from "../billing/plans"
import type { PlanModelAccess } from "../provider/provider.service"

/**
 * Whether a plan may run one model.
 *
 * Its own module because `model.service.ts` reaches the catalogue, which reaches
 * `config/env`, so nothing in that file loads without a database URL — and this
 * is the rule that decides who may spend money on which model. It reads two
 * plain records and returns a boolean; there is no reason it should need a
 * deployment to prove.
 *
 * Two rules, in order. An administrator who has listed models for this plan and
 * capability has said exactly what it may run, and that list wins. An empty list
 * is not "nothing" — it is "nothing has been said", and the tier rule in
 * `plans.ts` answers instead, which is what every deployment had before the
 * allowlist existed. Reading an empty list as a deny would lock every plan out
 * of every model on upgrade, silently and everywhere at once.
 */
export function planAllowsModel(
	access: PlanModelAccess,
	plan: PlanName,
	definition: Pick<ModelDefinition, "provider" | "model" | "capability" | "tier">,
): boolean {
	const allowed = access[definition.capability].allowed
	if (allowed.length > 0) {
		return allowed.includes(modelKey(definition.provider, definition.model))
	}
	return planLimits(plan).modelTiers.includes(definition.tier)
}
