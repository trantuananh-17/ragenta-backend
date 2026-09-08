import mysql from "mysql2/promise"
import { Client } from "pg"

import { ValidationError } from "../shared/errors"
import type { DataSourceTable } from "../db/schema/datasource.schema"

/**
 * Running one approved query against a customer's database.
 *
 * **Every limit here is enforced by the connection or the driver, never by
 * reading the SQL** (ADR-064). Inspecting a statement for the word `DELETE` is
 * the check that looks like security and is not: comments, casing, a CTE and a
 * dozen other spellings get past it. What holds is a read-only transaction, a
 * statement timeout the server enforces, a bound parameter list the driver
 * escapes, and a row cap applied while reading.
 *
 * The connection is opened per call and closed after. A pool would be faster and
 * would keep a socket open to somebody else's database between calls, which is a
 * thing to explain to a security reviewer for a saving nobody has measured.
 */

const CONNECT_TIMEOUT_MS = 8_000
const STATEMENT_TIMEOUT_MS = 10_000
const MAX_ROWS_HARD_CAP = 500

export type DataSourceEngine = "postgres" | "mysql"

export interface QueryOutcome {
	columns: string[]
	rows: unknown[][]
	/** True when the cap cut the result rather than the query ending. */
	truncated: boolean
	durationMs: number
}

export async function runQuery(
	engine: DataSourceEngine,
	dsn: string,
	sql: string,
	parameters: unknown[],
	rowLimit: number,
): Promise<QueryOutcome> {
	const limit = Math.min(Math.max(rowLimit, 1), MAX_ROWS_HARD_CAP)
	const started = Date.now()

	const outcome =
		engine === "postgres"
			? await runPostgres(dsn, sql, parameters, limit)
			: await runMysql(dsn, sql, parameters, limit)

	return { ...outcome, durationMs: Date.now() - started }
}

async function runPostgres(
	dsn: string,
	sql: string,
	parameters: unknown[],
	limit: number,
): Promise<Omit<QueryOutcome, "durationMs">> {
	const client = new Client({
		connectionString: dsn,
		connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
		// The server enforces this, so a query that hangs is killed at the far end
		// rather than leaving us holding a socket until our own timeout.
		statement_timeout: STATEMENT_TIMEOUT_MS,
	})

	try {
		await client.connect()
		// The real guarantee against a write. `SET TRANSACTION READ ONLY` makes
		// Postgres itself refuse an INSERT, UPDATE, DELETE, DDL or a function that
		// writes — whatever the statement says and however it is spelled.
		await client.query("BEGIN TRANSACTION READ ONLY")

		const result = await client.query({ text: sql, values: parameters, rowMode: "array" })
		await client.query("COMMIT").catch(() => undefined)

		const rows = result.rows as unknown[][]
		return {
			columns: result.fields.map((field) => field.name),
			rows: rows.slice(0, limit),
			truncated: rows.length > limit,
		}
	} catch (error) {
		throw asQueryError(error)
	} finally {
		await client.end().catch(() => undefined)
	}
}

async function runMysql(
	dsn: string,
	sql: string,
	parameters: unknown[],
	limit: number,
): Promise<Omit<QueryOutcome, "durationMs">> {
	const connection = await mysql
		.createConnection({ uri: dsn, connectTimeout: CONNECT_TIMEOUT_MS, rowsAsArray: true })
		.catch((error: unknown) => {
			throw asQueryError(error)
		})

	try {
		// MySQL has no `BEGIN TRANSACTION READ ONLY`, but it has this — and it
		// refuses a write for the whole session rather than per statement.
		await connection.query("SET SESSION TRANSACTION READ ONLY")
		await connection.query(`SET SESSION max_execution_time = ${STATEMENT_TIMEOUT_MS}`)

		const [rows, fields] = await connection.query({ sql, values: parameters })
		const asRows = Array.isArray(rows) ? (rows as unknown[][]) : []

		return {
			columns: (fields ?? []).map((field) => field.name),
			rows: asRows.slice(0, limit),
			truncated: asRows.length > limit,
		}
	} catch (error) {
		throw asQueryError(error)
	} finally {
		await connection.end().catch(() => undefined)
	}
}

/**
 * The database's own message, which is what makes a wrong column name
 * diagnosable — with the DSN stripped, because some drivers put the whole
 * connection string into a connection error and it carries the password.
 */
function asQueryError(error: unknown): ValidationError {
	const raw = error instanceof Error ? error.message : String(error)
	const scrubbed = raw.replace(/(:\/\/[^:@\s]+):[^@\s]+@/g, "$1:***@")
	return new ValidationError(`The database refused the query: ${scrubbed.slice(0, 400)}`)
}

/**
 * What tables and columns exist, for the authoring screen and for generation.
 *
 * Reads `information_schema` and nothing else — no data leaves the customer's
 * database here, only its shape. System schemas are excluded because a shop
 * owner reading this screen should see `orders`, not `pg_catalog`.
 */
export async function introspect(
	engine: DataSourceEngine,
	dsn: string,
): Promise<DataSourceTable[]> {
	const statement =
		engine === "postgres"
			? `select table_schema, table_name, column_name, data_type, is_nullable
			   from information_schema.columns
			   where table_schema not in ('pg_catalog', 'information_schema')
			   order by table_schema, table_name, ordinal_position
			   limit 2000`
			: `select table_schema, table_name, column_name, data_type, is_nullable
			   from information_schema.columns
			   where table_schema not in ('mysql', 'information_schema', 'performance_schema', 'sys')
			   order by table_schema, table_name, ordinal_position
			   limit 2000`

	const result = await runQuery(engine, dsn, statement, [], MAX_ROWS_HARD_CAP)

	const tables = new Map<string, DataSourceTable>()
	for (const row of result.rows) {
		const [schema, name, column, type, nullable] = row as [
			string,
			string,
			string,
			string,
			string,
		]
		const key = `${schema}.${name}`
		const existing = tables.get(key) ?? { schema, name, columns: [] }
		existing.columns.push({ name: column, type, nullable: nullable === "YES" })
		tables.set(key, existing)
	}

	return [...tables.values()]
}
