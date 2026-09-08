import { WORKSPACE_SYSTEM_ROLE_KEYS, systemRoleId } from "../../auth/permissions"

/**
 * Turns the role string Better Auth stores on `member.role` into the id of the
 * system role Ragenta grants for it.
 *
 * Alone in its own file and tested, for the reason `client-address.ts` and
 * `safe-fetch.ts` are: it is a security decision small enough to look obviously
 * correct while being wrong. Better Auth accepts an arbitrary string here and
 * documents a comma-separated list, so this reads the **first** entry and
 * validates it — and anything it does not recognise becomes `member`, the least
 * privileged role that can still use the product. Falling back upward, or
 * trusting the string as a role key, would hand somebody access nobody granted.
 */
export function primarySystemRoleId(roleString: string): string {
	const primary = roleString.split(",")[0]?.trim().toLowerCase() ?? ""
	const key = (WORKSPACE_SYSTEM_ROLE_KEYS as string[]).includes(primary) ? primary : "member"
	return systemRoleId("workspace", key)
}
