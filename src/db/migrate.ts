import { migrate } from "drizzle-orm/node-postgres/migrator"

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
	await closeDatabase()
}

main().catch(async (error) => {
	logger.error("Migration failed", error)
	await closeDatabase()
	process.exit(1)
})
