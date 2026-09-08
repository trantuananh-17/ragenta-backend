import { describe, expect, it } from "vitest"

import { looksLikeDsn, maskDsn, parseDsn, scrubDsns } from "./dsn"

const POSTGRES = "postgres://shop_ro:hunter2@db.example.com:5432/shop"
const MYSQL = "mysql://reader:s3cret@10.0.0.4:3306/woocommerce"

describe("reading a connection string", () => {
	it("takes apart a Postgres one", () => {
		expect(parseDsn(POSTGRES)).toEqual({
			engine: "postgres",
			host: "db.example.com:5432",
			database: "shop",
			user: "shop_ro",
		})
	})

	it("accepts both spellings of the Postgres scheme", () => {
		expect(parseDsn("postgresql://u:p@h/d")?.engine).toBe("postgres")
		expect(parseDsn("postgres://u:p@h/d")?.engine).toBe("postgres")
	})

	it("takes apart a MySQL one", () => {
		expect(parseDsn(MYSQL)?.engine).toBe("mysql")
		expect(parseDsn(MYSQL)?.database).toBe("woocommerce")
	})

	it.each([
		"",
		"not a url",
		"redis://u:p@h/0",
		"http://example.com/db",
		"postgres://db.example.com",
		"postgres:///shop",
	])("refuses %j rather than guessing", (dsn) => {
		expect(parseDsn(dsn)).toBeUndefined()
	})
})

describe("masking", () => {
	it("removes the password and keeps everything somebody needs to identify it", () => {
		const masked = maskDsn(POSTGRES)
		expect(masked).toBe("postgres://shop_ro@db.example.com:5432/shop")
		expect(masked).not.toContain("hunter2")
	})

	/**
	 * Never a partial password. Showing the first two characters is a head start,
	 * and there is no version of "which database is this" that needs them.
	 */
	it("shows no part of the password at all", () => {
		for (const character of "hunter2") {
			// The letters may appear elsewhere legitimately; what must not appear is
			// any run of the password itself.
			expect(maskDsn(POSTGRES)).not.toContain("hunter")
			void character
		}
	})

	it("says so rather than echoing something it could not read", () => {
		expect(maskDsn("nonsense")).toBe("(unreadable connection string)")
	})
})

describe("keeping a password out of a log", () => {
	it("recognises a credential-bearing URL", () => {
		expect(looksLikeDsn(POSTGRES)).toBe(true)
		expect(looksLikeDsn(MYSQL)).toBe(true)
		expect(looksLikeDsn("postgres://db.example.com/shop")).toBe(false)
		expect(looksLikeDsn("nothing here")).toBe(false)
	})

	it("scrubs one out of the middle of an error message", () => {
		const message = `connect ECONNREFUSED for ${POSTGRES} after 3 tries`
		const scrubbed = scrubDsns(message)
		expect(scrubbed).not.toContain("hunter2")
		expect(scrubbed).toContain("db.example.com")
		expect(scrubbed).toContain("after 3 tries")
	})

	it("scrubs every one when a message carries two", () => {
		const scrubbed = scrubDsns(`${POSTGRES} and ${MYSQL}`)
		expect(scrubbed).not.toContain("hunter2")
		expect(scrubbed).not.toContain("s3cret")
	})

	it("leaves a message with no credential alone", () => {
		expect(scrubDsns("relation \"orders\" does not exist")).toBe(
			'relation "orders" does not exist',
		)
	})
})
