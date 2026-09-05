# ragenta-backend

Hono API + BullMQ worker in one TypeScript codebase, two processes, one image.
Workspace-level context lives in `../CLAUDE.md` and `../.claude/docs/`.

## Commands

```bash
pnpm dev:api        # tsx watch, port 8080
pnpm dev:worker
pnpm build          # tsup → dist/main.api.js, dist/main.worker.js, dist/db/migrate.js
pnpm typecheck
pnpm db:generate    # after editing src/db/schema/* — writes SQL into ./drizzle
pnpm db:migrate
```

No test suite yet. `docker compose up -d` starts postgres and redis for local work.

## The auth-service reference is gone

It was removed on 2026-08-29 once Stripe — the last thing worth taking — had been ported. It lives
at `https://github.com/NYB-AI/auth-service`, last read at `134c6fe`.

`.gitignore` still excludes `auth-service/`, so re-cloning it here to check something is safe and
can never reach a commit. If you do, it stays **read-only**: never edit, stage or commit inside it
(`../.claude/rules/reference-repos.md`).

Its Better Auth skills were kept in `.claude/skills/`. They are third-party — do not edit them in
place; write a Ragenta skill beside them instead.

## Layer rules

```text
routes → controller → service → repository → db
```

- **Routes** are the authorization map. Every `:workspaceId` route carries `workspaceScope`;
  role-restricted ones also carry `requireWorkspaceRole(...)`.
- **Controllers** validate with a zod DTO, call exactly one service method, shape the response.
  No queries, no role checks, no business branching.
- **Services** hold the rules, own transactions, write the audit trail. They must not import
  `hono` or accept a `Context` — that is what lets a BullMQ job call the same method.
- **Repositories** are the only place SQL lives, and every method is workspace-scoped. They
  never enforce permissions and never return another tenant's rows.
- Errors are `AppError` subclasses from `src/shared/errors.ts`; `api/middleware/error-handler.ts`
  is the only file that maps them to HTTP.
- `src/config/env.ts` is the only reader of `process.env`.

Three layers sit beside that stack rather than inside it, because both the API and the worker use
them and neither is workspace-scoped:

- `src/ai/` — provider clients (`clients/`, plain `fetch`, no SDKs), the merged catalogue
  (`catalogue.ts`), embedding (`embed.ts`) and token estimation (`tokens.ts`).
- `src/storage/objects.ts` — S3-compatible object storage. Keys are generated from a document id,
  never from an uploaded filename.
- `src/vector/qdrant.ts` — one collection per embedding width; every search and delete carries a
  `workspaceId` filter (ADR-020).

## Adding an endpoint

1. DTO in `<module>.dto.ts`.
2. Service method (rules, transaction, audit) — reuse the repository, add one if the query is new.
3. Controller method: parse → service → respond.
4. Route line with `workspaceScope` and, if it changes people, settings or money, a role guard.
5. Add its entry to `ROUTE_DOCS` in `src/api/openapi.ts`. The path list comes from the router, so
   an undescribed route still appears in `/v1/docs` — as `Undocumented`, which is the reminder.
6. Schema change? `pnpm db:generate`, then read the SQL before committing it.

## Things that are easy to get wrong here

- **Never trust an id from the client.** The actor comes from the session; membership of the
  target comes from `workspaceScope`. A workspace the caller does not belong to answers 404.
- **Workspace == Better Auth organization.** Tables are `organization` / `member` / `invitation`
  because the plugin resolves them by those names. Say "workspace" everywhere above the
  repository. Teams are off on purpose.
- **Credits are a ledger.** Never `UPDATE credit_balance` without inserting the matching
  `credit_transaction` row in the same transaction. Idempotency is the unique
  `(kind, reference)` index — give every spend a stable reference.
- **Jobs run more than once.** Payloads carry ids only; processors re-read state and must be
  safe to repeat. Scheduled work lives in the worker, never `node-cron` in the API process.
- **Migrations are an explicit step.** `node dist/db/migrate.js` before the containers start,
  never on boot. Expand first, contract in a later release.
- Do not put product endpoints inside Better Auth plugins. That is what makes the reference
  service hard to layer, and this repo deliberately does the opposite.
- **Provider keys are write-only.** `provider_credential.encrypted_key` is read by
  `src/ai/catalogue.ts` and by nothing else. Every response carries `keyHint`, never the value, and
  nothing logs or audits the key itself (ADR-021).
- **A knowledge base freezes its embedding model.** Vectors from two models are not comparable, so
  changing it would return nonsense rather than degrade. Re-embedding is an explicit re-index.
- **Retrieval never runs unfiltered.** `searchChunks` takes the workspace id as a required
  argument and puts it in the Qdrant filter. Do not add a code path that does not.
- **Ingestion runs in the worker.** Parsing a PDF and calling an embedding provider takes tens of
  seconds; an HTTP request that does it times out behind the proxy and leaves a half-indexed
  document nobody knows about.
- **Retrieved document text is untrusted.** It is data in a prompt, never instructions. The system
  prompt in `src/modules/chat/prompt.ts` says so; keep it saying so.
