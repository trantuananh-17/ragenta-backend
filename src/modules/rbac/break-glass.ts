/**
 * Who is a platform administrator without a database row.
 *
 * Two sources, both deliberately outside `user_platform_role`:
 *
 * - `ADMIN_USER_IDS` from the environment. This is the break-glass path — a role
 *   edit that removes the last `superadmin` has to be recoverable by editing the
 *   VM's `.env`, not by writing SQL against production.
 * - `user.role` containing `admin`, which is what Better Auth's admin plugin
 *   writes and what the console's own "grant admin" button still sets. Every
 *   administrator who existed before roles did has this and nothing else, so
 *   dropping it would have locked all of them out on the deploy that introduced
 *   permissions.
 *
 * Alone in its own file and tested, for the reason `client-address.ts` is: it is
 * a security decision short enough to look obviously correct while being wrong.
 * The comma-splitting matters — Better Auth documents `role` as a list, and a
 * naive `includes("admin")` on the raw string would also match `readonly-admin`
 * or `admins-watchlist`, granting the console to a role named to describe
 * somebody rather than to empower them.
 */
export function isBreakGlassAdmin(
	user: { id: string; role?: string | null },
	adminUserIds: readonly string[],
): boolean {
	if (adminUserIds.includes(user.id)) return true

	return (user.role ?? "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.includes("admin")
}
