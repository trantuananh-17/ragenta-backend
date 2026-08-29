# ragenta-backend

The Ragenta API and background worker. One codebase, one image, two processes.

```text
Hono API  (start:api)  ─┬─ PostgreSQL (source of truth)
                        ├─ Redis / BullMQ ── Worker (start:worker)
                        └─ Better Auth (identity)
```

## Getting started

```bash
cp .env.example .env          # then set BETTER_AUTH_SECRET (min 32 chars)
docker compose up -d          # postgres, redis (minio + qdrant for later)
pnpm install
pnpm db:generate              # first run: turn src/db/schema into ./drizzle SQL
pnpm db:migrate
pnpm dev:api                  # http://localhost:8080/health
pnpm dev:worker               # in a second terminal
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev:api` / `pnpm dev:worker` | Watch mode for each process |
| `pnpm build` | Bundle all three entrypoints into `dist/` |
| `pnpm start:api` / `pnpm start:worker` | Run the built output (what the container does) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm docs:check` | Build the OpenAPI document and print every operation it contains |
| `pnpm db:generate` | Generate SQL migrations from `src/db/schema/*` |
| `pnpm db:migrate` | Apply migrations (explicit step, never on boot) |
| `pnpm db:studio` | Drizzle Studio |

There is no test suite yet.

## Layers

A request crosses them in one direction only. Nothing below a layer imports from above it.

```text
api/            Hono app, middleware, CORS, error mapping        ← knows HTTP
  └─ modules/<domain>/*.routes.ts      route table + guards
     └─ *.controller.ts                validate → call one service → shape response
        └─ *.service.ts                business rules, transactions, audit   ← no HTTP
           └─ *.repository.ts          SQL, always workspace-scoped
              └─ db/                   Drizzle schema + client
auth/ mail/ redis/ queue/              infrastructure the services depend on
jobs/ workers/                         the same services, driven by BullMQ instead of HTTP
```

Rules that keep it honest:

- A controller contains no `if (role === ...)` and no query. Authorization is middleware,
  rules are the service.
- A service never imports `hono` and never sees a `Context`. That is what lets a job call it.
- A repository never enforces permissions; it also never returns rows from another workspace.
- Errors are thrown as `AppError` subclasses (`src/shared/errors.ts`) and become HTTP in exactly
  one place, `api/middleware/error-handler.ts`.

## Layout

```text
src/
├── main.api.ts / main.worker.ts   process entrypoints
├── config/env.ts                  the only reader of process.env
├── shared/                        errors, logger, ids, pagination
├── db/                            drizzle schema, client, migrate runner
├── auth/                          Better Auth instance, roles, active workspace
├── mail/                          transporter + templates
├── redis/  queue/                 connections and BullMQ queues
├── modules/                       workspace, project, billing, usage, audit, admin, account
├── jobs/                          job names + payload schemas
└── workers/                       worker bootstrap + processors
```

## API surface

Interactive reference: **`/v1/docs`** (spec at `/v1/openapi.json`). It is generated from the live
Hono router plus Better Auth's own schema, so both halves of the API are on one page and a route
cannot go missing from it. On in development, off in production unless `DOCS_ENABLED=true`.

```text
GET    /health
GET    /v1/docs                             API reference
GET    /v1/openapi.json

/v1/auth/*                                  Better Auth (sign-in, sign-up, reset, org primitives)

GET    /v1/me                               current user + active workspace
GET    /v1/me/workspaces
GET    /v1/plans                            plan catalogue + top-up packs

GET    /v1/workspaces                       workspaces the caller belongs to
POST   /v1/workspaces
GET    /v1/workspaces/:id                   workspace + plan + credits
PATCH  /v1/workspaces/:id                   owner | admin
GET    /v1/workspaces/:id/members
PATCH  /v1/workspaces/:id/members/:memberId owner | admin
DELETE /v1/workspaces/:id/members/:memberId owner | admin
GET    /v1/workspaces/:id/invitations       owner | admin
POST   /v1/workspaces/:id/invitations       owner | admin, seat-capped by plan
DELETE /v1/workspaces/:id/invitations/:invitationId
GET    /v1/workspaces/:id/projects          ?includeArchived=true
POST   /v1/workspaces/:id/projects          owner | admin | member
GET    /v1/workspaces/:id/projects/:projectId
PATCH  /v1/workspaces/:id/projects/:projectId          owner | admin | member
POST   /v1/workspaces/:id/projects/:projectId/archive  owner | admin
POST   /v1/workspaces/:id/projects/:projectId/restore  owner | admin
DELETE /v1/workspaces/:id/projects/:projectId          owner, archived only

GET    /v1/workspaces/:id/billing           plan, credits, seats
GET    /v1/workspaces/:id/billing/transactions
GET    /v1/workspaces/:id/usage             ?days=30 — spend by operation/provider/model
GET    /v1/workspaces/:id/usage/records     ?projectId= &operation=
GET    /v1/workspaces/:id/models            model catalogue, gated by plan tier

GET    /v1/admin/users                      platform admin only
GET    /v1/admin/workspaces
GET    /v1/admin/workspaces/:id
POST   /v1/admin/workspaces/:id/credits     signed adjustment, audited
PUT    /v1/admin/workspaces/:id/plan
GET    /v1/admin/audit-log
```

## Workspace == organization

Ragenta's tenant is the **workspace**. It is implemented by Better Auth's organization plugin,
so the database tables are `organization` / `member` / `invitation` — those names are the
plugin's contract. Everything above the repository layer says "workspace".

Teams are off. Ragenta's unit inside a workspace is the Project, a domain entity of ours.

## Projects

A workspace is the tenant and the billing boundary. A **project** is the working boundary — where
agents, knowledge bases and conversations will live, and what usage is attributed to. Usage rows
carry both ids, so "which project spent the credits" is one query, not a second ledger.

Archiving is reversible and keeps history; permanent delete requires archiving first and is
owner-only. Deleting a project nulls `usage_ledger.project_id` rather than removing the rows —
billing history must stay complete.

## Credits and usage

Two ledgers, written in one transaction, sharing a `reference`:

- `credit_transaction` — what happened to the balance. Billing truth.
- `usage_ledger` — why: provider, model, input/output/embedding tokens, project, user.

`credit_balance` is a materialised sum; every change to it is written alongside its
`credit_transaction` row, so the balance is always recomputable. Idempotency is the unique
`(kind, reference)` index plus the unique `usage_ledger.reference` — a retried job posts once.

Plan credits are spent before top-up credits, and reset (not accumulate) at each refill. Top-up
credits never expire.

### The credit unit

**One credit is one input token of the baseline model** (Sonnet-class, $3/M). Every other model's
rate is derived from what it actually costs, so credit consumption tracks provider cost and gross
margin does not move when a customer switches model — 2M credits cost us about the same whether
they are spent on Haiku or on Opus. A flat per-token price cannot do that: Opus output is 500× a
gpt-4o-mini input token.

Tokens become credits **at write time** in `src/modules/usage/pricing.ts`, and the amount is
frozen on the usage row with its `pricingVersion`. Changing a price never restates what a
workspace was already charged. Charge from provider-reported token counts *after* the call; check
affordability and model entitlement *before* it.

`usageService.recordAndCharge()` is the single entry point the AI layer will call;
`usageService.assertModelAllowed()` is the gate it must pass first.

### Plans

| | Free | Pro | Team | Enterprise |
| --- | --- | --- | --- | --- |
| Price | $0 | $29/seat/mo | $99/mo (5 seats, $19 extra) | custom |
| Credits | 300k **once** | 2M/seat/mo | 8M/mo | by contract |
| Seats | 1 | 25 | 25 | ∞ |
| Models | economy only | all | all | all |
| Top-ups | ✗ | ✓ | ✓ | invoiced |

Top-up packs: 1M/$39, 5M/$175, 15M/$450. Their unit price is deliberately higher than the credits
bundled in a plan — cheaper top-ups would make sitting on free the rational choice.

Free grants **once at signup**, not monthly: `creditsForPeriod()` returns null for it so the
refill job skips the plan entirely. Economy-only model access is what keeps that grant under a
dollar of provider cost.

`GET /v1/plans` serves this table from the same constants the seat cap and refill job enforce.

## What was intentionally left out of the port

Carried over from `auth-service`: layered Better Auth setup, the session `activeOrganizationId`
seed, workspace roles and seat caps, the credit ledger shape, the audit log, Docker/Drizzle setup.

Deliberately **not** carried over:

| Dropped | Why |
| --- | --- |
| Teams | Ragenta uses Projects inside a workspace |
| Waitlist, onboarding wizard, UTM, PostHog | Product-specific to the reference |
| Stripe | No payment provider chosen; `subscription` keeps provider-neutral columns |
| MCP OAuth provider, one-tap, JWT plugin | No consumer yet; add when one exists |
| bcrypt password hashing | Only existed to match imported legacy hashes. Better Auth's default is used |
| `node-cron` in the API process | Scheduled work belongs to the worker (BullMQ repeatable jobs) |

Not built yet: the AI layer (`src/ai/`), per-workspace model/provider credentials, knowledge
bases, documents, chat, agents, API keys. MinIO and Qdrant are in `docker-compose.yml` but have no
client dependency until the ingestion module needs one.

## auth-service/

The reference implementation, cloned here for reading and **gitignored**. Never edit it, never
commit it. See `CLAUDE.md` and `../.claude/rules/reference-repos.md`.
