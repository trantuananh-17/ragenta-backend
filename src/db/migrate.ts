import { migrate } from "drizzle-orm/node-postgres/migrator"

import { reconcileRbac } from "../modules/rbac/rbac.seed"
import { logger } from "../shared/logger"
import { closeDatabase, db } from "./client"

/**
 * Explicit migration step. Run as `pnpm db:migrate` locally and as
 * `node dist/db/migrate.js` in a deploy, BEFORE the API and worker containers
 * start — never as a container entrypoint side effect (ADR-003).
 */
async function main() {
	logger.info("Applying migrations")
	await migrate(db, { migrationsFolder: "./drizzle" })
	logger.info("Migrations applied")

	// The permission catalogue lives in code and the `permission` table is a copy
	// of it, so reconciling belongs here rather than in a hand-written INSERT: a
	// release that adds a permission gets it onto the built-in roles by the same
	// step that adds the column it guards. Idempotent, so it runs every deploy.
	logger.info("Reconciling roles and permissions")
	await reconcileRbac(db)
	logger.info("Roles and permissions reconciled")

	await closeDatabase()
}

main().catch(async (error) => {
	logger.error("Migration failed", error)
	await closeDatabase()
	process.exit(1)
})
