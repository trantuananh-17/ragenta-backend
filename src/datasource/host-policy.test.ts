import { describe, expect, it } from "vitest"

import { assertDsnHostAllowed } from "./host-policy"

/**
 * Address literals only, so nothing here needs a resolver. The hostname path is
 * `assertHostAllowed`'s, which has its own tests.
 */
const PRIVATE = [
	["loopback", "postgresql://u:p@127.0.0.1:5432/db"],
	["a private range", "postgresql://u:p@10.1.2.3:5432/db"],
	["another private range", "mysql://u:p@192.168.1.10/db"],
	["docker's default bridge", "postgresql://u:p@172.17.0.1:5432/db"],
	["the metadata endpoint", "postgresql://u:p@169.254.169.254:5432/db"],
	["IPv6 loopback", "postgresql://u:p@[::1]:5432/db"],
	["loopback spelled as IPv6", "postgresql://u:p@[::ffff:127.0.0.1]:5432/db"],
] as const

describe("assertDsnHostAllowed", () => {
	it.each(PRIVATE)("refuses %s", async (_name, dsn) => {
		await expect(assertDsnHostAllowed(dsn, false)).rejects.toThrow(/public address/)
	})

	it("allows a public address", async () => {
		await expect(assertDsnHostAllowed("postgresql://u:p@93.184.216.34:5432/db", false))
			.resolves.toBeUndefined()
	})

	it("allows a private address only where the deployment says so", async () => {
		// The single-tenant install, where Ragenta and the database share a network
		// on purpose. Every other deployment leaves this off.
		await expect(assertDsnHostAllowed("postgresql://u:p@10.1.2.3:5432/db", true))
			.resolves.toBeUndefined()
	})

	it("refuses a string that is not a connection string", async () => {
		await expect(assertDsnHostAllowed("not a dsn", false)).rejects.toThrow(/could not be read/)
	})
})
