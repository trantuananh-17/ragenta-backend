/**
 * Two tables answer two different questions, and keeping them apart is deliberate.
 *
 * - `catalogue.ts` is **Ragenta's** authorization: the permission keys a role in
 *   the database is composed from, and what every route and domain service asks
 *   before it acts. This is the one to extend.
 * - `better-auth.ts` is the access controller the **organization plugin** consults
 *   for the membership primitives it implements itself — creating an invitation,
 *   changing a member's role, deleting the organization. Better Auth resolves
 *   those inside its own handlers, before any of our code runs, so it needs its
 *   own statements in its own shape.
 *
 * They are not merged. Better Auth's `defaultStatements` already owns the
 * resource names `member` and `invitation` with its own action lists, and folding
 * our catalogue into them would silently redefine what the plugin enforces on its
 * own endpoints. The two overlap only on membership, and the overlap is checked
 * by `catalogue.test.ts` rather than by hoping.
 */
export * from "./better-auth"
export * from "./catalogue"
