-- Better Auth 1.7 scopes account identity on (issuer, accountId) instead of on
-- providerId. `issuer` is required, so drizzle-kit generates a bare
-- `ADD COLUMN ... NOT NULL`, which Postgres refuses on a table that already has
-- rows. Hand-widened into add / backfill / constrain so this runs against an
-- empty environment and a populated one alike.
--
-- The backfill values are Better Auth's own, from
-- @better-auth/core/src/db/schema/account.ts: `createLocalAccountIssuer` for
-- credentials and `createOAuthAccountIssuer` for a social provider that declares
-- no issuer of its own — which is every built-in one, Google included. Both
-- percent-encode the provider id; every provider id in use here is a plain
-- lowercase identifier, so encoding it is a no-op and is not reproduced in SQL.
ALTER TABLE "account" ADD COLUMN "issuer" text;--> statement-breakpoint

UPDATE "account"
SET "issuer" = CASE
	WHEN "provider_id" = 'credential' THEN 'local:credential'
	ELSE 'local:oauth:' || "provider_id"
END
WHERE "issuer" IS NULL;--> statement-breakpoint

ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint

-- Deliberately allowed to fail rather than be forced. A duplicate here means two
-- rows claim the same subject from the same issuer, which is an identity
-- collision the upgrade guide says to resolve by hand — silently keeping one
-- would sign somebody into the wrong account.
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" USING btree ("issuer","account_id");
