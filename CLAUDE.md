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

## `auth-service/` is read-only

The reference implementation is cloned into this repo and **gitignored**. Never edit, stage or
commit anything inside it. Consult it only for auth/session/OAuth questions, and prefer the
pattern over the file — see `../.claude/rules/reference-repos.md`.

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
