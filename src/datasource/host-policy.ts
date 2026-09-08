import { assertHostAllowed } from "../modules/agent/tools/safe-fetch"
import { ValidationError } from "../shared/errors"

/**
 * Where a data source is allowed to point.
 *
 * A connection string is typed by a customer and dialled by **us**, from inside
 * the deployment's network. That is the same surface as an agent fetching a URL
 * a model chose, and it gets the same check — `assertHostAllowed`, so there is
 * one implementation of the address rules to audit rather than two.
 *
 * Without it, `postgresql://user:pass@postgres:5432/ragenta` is one workspace
 * asking this service to open a connection to Ragenta's own database, and a
 * `10.x` address is a port scan of everything else on that network, read off the
 * difference between "connection refused" and "timed out". Neither needs a
 * password to be useful to whoever typed it.
 *
 * `allowPrivateHosts` comes from `DATASOURCE_ALLOW_PRIVATE_HOSTS`, for a
 * single-tenant install where Ragenta and the database sit on one private
 * network on purpose. It must stay off wherever more than one customer shares a
 * deployment, which is why it defaults to off and is named for what it allows
 * rather than what it disables. It is passed in rather than read here so this
 * module needs no environment to be tested.
 */
export async function assertDsnHostAllowed(dsn: string, allowPrivateHosts: boolean): Promise<void> {
	if (allowPrivateHosts) return

	let hostname: string
	try {
		hostname = new URL(dsn.trim()).hostname
	} catch {
		throw new ValidationError("That connection string could not be read.")
	}

	// A URL keeps an IPv6 address in its brackets; the address rules want the
	// address. `isIP` is the difference between `[::1]` and a host called `::1`.
	const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname
	if (!host) throw new ValidationError("That connection string names no host.")

	try {
		await assertHostAllowed(host)
	} catch (error) {
		const reason = error instanceof Error ? error.message : "It could not be checked."
		throw new ValidationError(
			`${reason} A data source must be reachable at a public address — private, loopback and link-local addresses belong to this deployment's own network, not to a customer's database.`,
		)
	}
}
