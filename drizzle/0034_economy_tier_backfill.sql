-- Reclassifies imported models against the lowered economy ceilings.
--
-- `tier` is computed by `tierFor` once, at import time, and stored — so lowering
-- the ceilings in `src/ai/models.ts` leaves every row already pulled from
-- OpenRouter carrying the tier it was given under the old 1 / 5 boundary. Those
-- rows are what `planAllowsModel` reads, so without this backfill the free plan
-- keeps whatever the old, sevenfold-wide economy tier let it run.
--
-- The two literals are repeated here rather than imported from the constants
-- deliberately: a migration states what the database looked like on the day it
-- ran. When the ceilings move again, this file must still mean 0.50 / 3.00, or
-- replaying the history would produce a different database than the one it
-- described.
-- Rerank rows are left alone. `tierFor` never sees a rerank model — the price of
-- a reranker is not comparable to a chat model's and `cohere:rerank-v3.5` is
-- economy at an input rate of 4 on purpose. Reclassifying them here would take
-- reranking away from the free plan as a side effect of a chat-tier decision.
UPDATE "provider_model"
SET "tier" = CASE
	WHEN "input_per_million" <= 0.50 AND "output_per_million" <= 3.00 THEN 'economy'
	ELSE 'premium'
END
WHERE "capability" <> 'rerank';
