ALTER TABLE "usage_ledger" ADD COLUMN "cost_usd" numeric(16, 8) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- Rows priced before this column existed. The dollars are recoverable exactly:
-- `credits` was computed as usd / BASELINE_USD_PER_MILLION * 1e6 and frozen, and
-- that constant has never moved from 3. This is a one-time opportunity — once it
-- does move, the arithmetic stops being true for rows written before the change,
-- and no later migration can tell which side of it a row falls on.
UPDATE "usage_ledger" SET "cost_usd" = ROUND("credits" * 3 / 1000000, 8);
