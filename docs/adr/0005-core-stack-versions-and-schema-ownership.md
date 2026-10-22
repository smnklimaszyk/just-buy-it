# ADR-0005: Version pinning and one migrate step for all schemas

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0001, 0006, 0007, 0011, 0012, 0014, 0021; D-01, D-37

## Context

- Drizzle owns `app` and `ebay_live`, Better Auth `auth`, pg-boss `pgboss`. Better Auth's `migrate` needs Kysely; with Drizzle you `generate` and apply the output (`@better-auth/cli` is unsupported; use `auth`). pg-boss migrates on `start()` unless `migrate: false`, then `start()` throws if migrations are pending.
- `typescript` latest is 7.0.2; typescript-eslint 8.71.x needs `<6.1.0`. Drizzle 1.0, Hono 5 and Better Auth 1.8 are pre-releases.
- Node 26 becomes LTS on 2026-10-28; Node 24 is in maintenance from 2026-10-20, end of life 2028-04-30. The repo was created 2026-10-19.

## Decision

Every dependency is an exact version (or `workspace:*`), with a committed lockfile and a 7-day minimum release age. The first pin of each package is the newest release at least 7 days old on repo creation day: better-auth/`auth` 1.7.11 (2026-10-19) and turbo 2.11.9 (2026-10-16) are too young today. New majors and any Better Auth minor wait for an update to this ADR. Node 24 now; one pull request moves to Node 26 at the first 26.x LTS release, provided the image library (phase 0) has a prebuilt Linux x64 glibc binary for it. No odd lines (27).

One migrate step, run once per deploy as a one-off container, owns all schemas. Runner `packages/db/src/migrate.ts` holds a session `pg_advisory_lock` on a fixed key and exits non-zero on failure so the deploy stops (ADR 0012):

1. Drizzle migrations for `app`, `auth`, `ebay_live`. Better Auth schema: `pnpm exec auth generate --adapter drizzle --dialect postgresql --output packages/db/schema/auth.ts -y`, committed, made into SQL by `drizzle-kit generate`.
2. `pg-boss migrate` for `pgboss` (from S4, see the S1b amendment).

Server and worker construct pg-boss only through the queue wrapper with `migrate: false` (from S4).

Rules:

- `engines.node` is a major range (`>=24 <25`, later `>=26 <27`); `.nvmrc` and Dockerfile `FROM` name one exact patch. `packageManager` names an exact pnpm version. CI installs with `--frozen-lockfile`.
- `drizzle.config.ts` sets `schemaFilter: ["app", "auth", "ebay_live"]`; no `drizzle-kit push` on shared or production databases.
- Expand then contract: DROP and RENAME ship a release after code stopped using the object, in a file named as a contract migration.
- Restore (ADR 0014 dump keeps all table definitions, no data of `ebay_live` or pg-boss job tables): `ebay_live` migrations are DDL only, no foreign key points into it, the migrate step runs after a restore. Drizzle finds nothing pending; pg-boss migrate recreates a missing `pgboss` schema.

| Package | Pin line | Held back |
|---|---|---|
| typescript / typescript-eslint | 6.0.x / 8.x | TS 7 until typescript-eslint supports it |
| pnpm / turbo | 12.x / 2.11.x | next major |
| hono / vite / react | 4.13.x / 8.3.x / 19.3.x | Hono 5, next majors |
| drizzle-orm / drizzle-kit | 0.45.x / 0.31.x | 1.0 |
| pg-boss / zod | 12.x / 4.6.x | next major |
| better-auth / auth CLI | 1.7.x, same version | 1.8 (can change the generated schema) |

Versions from https://registry.npmjs.org/, 2026-10-19.

**S1b amendment (2026-10-20)**:

- The migrations folder is `packages/db/migrations/` (Drizzle 0.31 layout: `NNNN_name.sql` plus `meta/_journal.json`).
- The runner itself runs `ALTER DATABASE ... SET timezone TO 'UTC'` (ADR 0008).
- The runner sets `lock_timeout` 10 s and `statement_timeout` 5 min on its session, and connects with a 10 s timeout, so a migration waiting on a lock or a runaway statement fails instead of holding the deploy.
- The runner checks the journal and the applied hashes itself before calling Drizzle, because Drizzle 0.45.4 compares only the journal `when` values: it never notices an applied file that was edited, and it skips a new entry whose `when` is older than the last applied one. Both stop the migration. Applied rows newer than the release's folder (an older release deployed over a newer schema) are allowed and logged.
- pg-boss is not part of S1b. The pg-boss migrate step comes in S4 with the first job and must use the pinned package's CLI or its `migrateCommands` run by our runner, never an in-process `start()` followed by `stop()`, which skips the async index builds.

**MVP amendment (2026-10-21)**:

- pg-boss is pinned at 12.38.0 (published 2026-10-13, pg-boss schema version 46), with its required peer `@opentelemetry/api` pinned at 1.9.1 in `packages/db`. Every pg-boss update, patch included, waits for approval on the Renovate dependency dashboard.
- Step 2 is `packages/db/src/queue/migrate-queue.ts`, run by the migrate runner under its advisory lock after the Drizzle migrations and the role passwords. It reads `pgboss.version`. With no schema it creates schema `pgboss` owned by role `worker` and runs pg-boss's construction plans as `worker` on the locked client, so every pg-boss object belongs to the worker and runtime maintenance needs no superuser. At version 46 it does nothing. Any other version stops the deploy with exit 1. The queues are created in the same step. Neither the CLI nor an in-process `start()` migrates.
- A fresh schema has no async index builds; a test checks that every `pgboss` index is valid.
- No upgrade path to a later pg-boss schema is built. It comes with the first pg-boss update.
- The worker starts pg-boss with `migrate: false`; a missing or different schema version makes `start()` throw and the worker exit 1, so Compose marks it unhealthy and the deploy rolls back. The server does not start pg-boss in the MVP.

## Alternatives considered

- **Prisma 7**: own schema language, less control over migration SQL.
- **Drizzle 1.0 RCs**: the migration tool must not shift under us.
- **Each library migrates at start**: races on `pgboss`; Better Auth with Drizzle cannot; no review.
- **Caret ranges plus lockfile**: unreviewed bumps; ranges admit TS 7, which breaks lint.
- **Exclude `ebay_live` and `pgboss` from the dump**: the `drizzle` log would list migrations for missing tables.

## Consequences

**Positive**
- One schema owner; a failed migration stops the deploy.
- A restore matches its migration log with no repair step.
- Reproducible builds; releases pulled within 7 days never reach us.

**Negative**
- Each Better Auth upgrade needs regenerate, diff review by Simon, and a migration.
- Steady Renovate pull requests, merged weekly after CI and fresh-context review (D-37).
- We own about 50 lines of migrate runner, its tests and two CI scripts.
- One planned Node 24 to 26 move.

**Risks**
- Better Auth may not generate into a non-default schema (unverified): check in phase 0; else a post-generate script wraps it in `pgSchema('auth')`.
- An old image may refuse a newer pg-boss schema on rollback (from S4): ship pg-boss upgrades alone with `pg-boss plans migrate` output; `pg-boss rollback` in the runbook.
- A contract migration breaks rollback: CI check below from the first migration, release rule in ADR 0012.
- Renovate bumps a held version: `allowedVersions` in `packageRules`.
- pg-boss renames job tables, so ADR 0014's exclusion misses: the restore test catches rows.

## How we check it

- CI script enforces the pin rules above. Fails today: root `engines.node` is `>=24`.
- CI: regenerating the Better Auth schema gives no diff; `drizzle-kit generate` on a clean tree writes nothing.
- CI, from the first migration: reject DROP or RENAME outside contract migrations, and row writes in `ebay_live` migrations.
- Integration test (Postgres 18): two parallel runners on an empty database both exit 0, nothing pending; from S4, server and worker start with `migrate: false` and `start()` throws if pg-boss migrations are pending.
- Restore test (also the monthly drill): restore the ADR 0014 dump, migrate; four schemas and `drizzle` log exist, tables match a fresh migrate, `ebay_live` and job tables empty.
- Lint: no `new PgBoss(` outside the queue wrapper. Reviews of `renovate.json` edits ask "ADR 0005 updated?".

## Revisit when

- Drizzle 1.0, Hono 5 or Better Auth 1.8 go stable; typescript-eslint supports TS 7.
- Node 26 LTS ships (move), a fallback condition is used, or Node 28 becomes LTS.
- pg-boss changes `migrate: false` or its table names; Better Auth's CLI can migrate through Drizzle.
- ADR 0014 changes the dump, a second database or replica appears, or server and worker deploy apart.
