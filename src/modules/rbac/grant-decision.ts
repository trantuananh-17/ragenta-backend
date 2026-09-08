/**
 * The rule that combines what a role granted with what was granted on one
 * resource. Alone in its own file and tested, because it is the sentence the
 * whole per-resource layer reduces to and it is short enough to be got wrong
 * silently.
 *
 * **Deny wins over everything**, including an allow on the same resource and
 * anything a role gave. A narrowing grant is the case people actually ask for —
 * "she may use every knowledge base except the HR one" — and a narrowing that
 * could be out-voted by adding a role is a security control that quietly stops
 * working. There is no precedence between subjects for the same reason: a deny
 * written against a role is not weaker than a deny written against a person.
 *
 * An allow can only widen. It exists so somebody with no blanket permission can
 * be given one project, which is the other half of what a resource grant is for.
 */

export type GrantEffect = "allow" | "deny"

export function decideResourcePermission(
	grantedByRole: boolean,
	effectsOnResource: readonly GrantEffect[],
): boolean {
	if (effectsOnResource.includes("deny")) return false
	if (grantedByRole) return true
	return effectsOnResource.includes("allow")
}
