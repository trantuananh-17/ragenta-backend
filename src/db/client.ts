import { drizzle } from "drizzle-orm/node-postgres"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { sql } from "drizzle-orm"
import { Pool } from "pg"

import { env } from "../config/env"
import * as schema from "./schema"

export type Database = NodePgDatabase<typeof schema>
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]

/**
 * Anything that reads or writes. Repositories accept this so the same method
 * works inside and outside a transaction — the service decides which.
 */
export type DbExecutor = Database | Transaction

let pool: Pool | undefined
let database: Database | undefined

function getPool(): Pool {
	if (!pool) pool = new Pool({ connectionString: env.databaseUrl })
	return pool
}

function getDatabase(): Database {
	if (!database) database = drizzle(getPool(), { schema })
	return database
}

/**
 * Lazily connected: importing this module must not open a socket, so the
 * migration runner and the worker can import repositories without the API's
 * pool being created twice.
 */
export const db = new Proxy({} as Database, {
	get(_target, prop, receiver) {
		return Reflect.get(getDatabase() as object, prop, receiver)
	},
})

export async function checkDatabaseConnection(): Promise<boolean> {
	try {
		await getDatabase().execute(sql`select 1`)
		return true
	} catch {
		return false
	}
}

export async function closeDatabase(): Promise<void> {
	await pool?.end()
	pool = undefined
	database = undefined
}
