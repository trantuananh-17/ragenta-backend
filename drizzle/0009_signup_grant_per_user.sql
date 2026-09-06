-- Re-keys the welcome grant from the workspace to the account that owns it.
--
-- `signup:<workspaceId>` handed out trial credits once per *workspace*, so one
-- account could mint them by creating workspaces. The service now writes
-- `signup:user:<userId>` and the unique (kind, reference) index does the
-- enforcing. Without this backfill every existing account would collect one
-- more grant from its next workspace, because that reference has never been used.
--
-- Only the earliest grant per owner is re-keyed; a later one keeps its old
-- reference. Those credits were already handed out and may already have been
-- spent, so clawing them back here would make balances disagree with the ledger
-- that explains them — and the unique index would refuse the second row anyway.
WITH owner_of AS (
    SELECT DISTINCT ON (organization_id) organization_id, user_id
    FROM "member"
    WHERE role = 'owner'
    ORDER BY organization_id, created_at, id
), target AS (
    SELECT
        t.id,
        o.user_id,
        ROW_NUMBER() OVER (PARTITION BY o.user_id ORDER BY t.created_at, t.id) AS rn
    FROM credit_transaction t
    JOIN owner_of o ON o.organization_id = t.organization_id
    WHERE t.kind = 'signup_grant'
      AND t.reference = 'signup:' || t.organization_id
)
UPDATE credit_transaction t
SET reference = 'signup:user:' || target.user_id
FROM target
WHERE t.id = target.id
  AND target.rn = 1;
