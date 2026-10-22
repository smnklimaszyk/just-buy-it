# ADR-0006: Package boundaries with an enforced import graph, and ports only where needed

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0005; D-01, D-37

## Context

- Only `domain` has an import rule; server (Price check, Refresh, Redrive) and worker share flows.
- Planned `shared` mixes contracts, env schema and thresholds: a cycle with `domain`.
- One-off commands (migrate, user CLI, backups) lack a home and env schema.
- Simon builds alone with agents (D-01): review-only rules are weak; boundaries cost upkeep.
- Sandbox Browse search reportedly returns total 0 ([community thread](https://community.ebay.com/t5/RESTful-Buy-APIs-Browse/Sandbox-API-always-returns-0-results/m-p/33711715), about 3 years old, no eBay answer) and cannot show EBAY_DE supply, filters or delays (ebay-api-9).

## Decision

4 apps and 7 packages; dependency-cruiser enforces this graph in CI. Four ports; the rest are plain modules or function parameters.

| Package | May import | Runtime deps | Holds |
|---|---|---|---|
| `contracts` | nothing | `zod` | HTTP API schemas |
| `domain` | nothing | none (allowlist, empty) | Pure logic, use cases, ports, `PriceSource`, rules-only evaluator, sectors, configs, contract suites (`src/testing/`), type-only `Logger` |
| `logging` | nothing | `pino` | Options, redaction; apps only |
| `ebay`, `llm`, `notify`, `db` | `domain` only | own SDKs | Adapters, infra modules |
| `server` | `contracts`, `domain`, `logging`, adapters | any | Routes, auth, deletion endpoint, user CLI |
| `worker` | `domain`, `logging`, adapters | any | Job handlers |
| `ops` | `domain`, `db`, `logging` | any | `migrate`, backup sentinel; env = database URL plus the `app` role password (S3) |
| `web` | `contracts` | React, Vite | Screens |

Rules:
- No app imports another app; no cycles; `exports` only `.` (plus `./testing` in `domain`).
- Adding an npm package to the `domain` allowlist needs an ADR change and fresh-context review; Simon reads that diff.
- Use cases live in `domain`, take one dependency object; handlers parse, compose, call.
- Retention: use case in `domain`, delete queries in `db`. pg-boss wrapper: `packages/db/src/queue`.
- Atomic write plus enqueue (ADR 0015): `type InTransaction<S> = <T>(work: (scope: S) => Promise<T>) => Promise<T>`, implemented in `db` with Drizzle and pg-boss `fromDrizzle`; no outbound calls in `work`.
- Cross-adapter needs (eBay call counter, ADR 0007) are passed in as functions; `ebay` never imports `db`.
- Only `apps/*/src/env.ts` reads `process.env`; packages get config as arguments; SDK clients get credentials explicitly.
- `ops migrate` calls `packages/db/src/migrate.ts`, run as a one-off container on each deploy. `drizzle.config.ts` serves only `generate` and reads no env.
- `contracts` does not import domain types; the server maps them; a type test catches enum drift.
- Backup scripts: shell in `infra/backup/`, fail on unset variables. `fixtures/` is imported only by tests and the fixture adapter.
- Zod only at boundaries; sector parsers are hand-written; configs use `satisfies`.

**S1b amendment (2026-10-20)**:

- `exports` allows only `.`, so ADR 0007's rule that the server imports only four `packages/ebay` modules cannot be checked by dependency-cruiser through the package entry. S1b keeps the single entry. One of the two rules is picked before S3.
- In apps, `process.env` is read only in `apps/*/src/env.ts`; ESLint (`no-restricted-syntax`) enforces it in `apps/*/src/**`, tests excepted. Packages may not use the `process` global at all.
- The `fromDrizzle` wording is settled in S4, when pg-boss arrives.

**S3 amendment (2026-10-20)**:

- `ops` env is the database URL plus the `app` role password (`POSTGRES_APP_PASSWORD`). `ops migrate` sets that password on role `app` after the migrations and then checks the role by connecting as `app`.
- The S1b open point is decided: the single `exports` entry stays, and ADR 0007's rule that the server imports only four `packages/ebay` modules is dropped. dependency-cruiser cannot check modules behind one entry; `packages/ebay/src/index.ts` is short, so a new export shows in review.

**MVP amendment (2026-10-21)**:

- `apps/worker` and the packages `domain`, `llm` and `notify` exist. `packages/db` has a second entry, `@ebay-sniper/db/queue`, for the pg-boss wrapper, used by the worker and by `ops migrate`; the server imports only the main entry and never loads pg-boss.
- The `notify` adapter is SMTP through nodemailer (ADR 0035), not SES.
- The `fromDrizzle` wording is settled: it is not used. The poll, sweep, enrich and screen transactions enqueue with pg-boss's `db` option on the checked-out `pg` client (an `executeSql` wrapper), so the job and the rows commit or roll back together. The worker has no Drizzle dependency.
- New dependency-cruiser rules: `server-no-llm` and `server-no-notify` (ADR 0007: the server never calls Anthropic and sends no alert email), `pg-boss-only-in-queue` (only `packages/db/src/queue/` imports pg-boss), `nodemailer-only-in-notify`, and `domain-no-runtime-deps` (domain source imports no npm package and no Node module; tests may import vitest). Each has a fixture in `tools/depcruise-selftest/fixtures/` that must report exactly its rule.
- ESLint (`no-restricted-syntax`) rejects the Anthropic API host string in any file outside `packages/llm`.

| Port | Adapters | Why |
|---|---|---|
| `ListingSource` | Browse production, synthetic fixtures. No sandbox adapter | Dev and CI need no production keyset |
| `PriceSource` | Watch max price (default), active-set asks (ADR 0017), later a ledger (minimal retention) | Fair-value method set by config |
| `ListingEvaluator` | Claude (`llm`), rules only. No provider types | Kill switch (D-18) |
| `Notifier` | SES, in-memory recorder; Telegram planned (phase 5) | Channels change, decisions do not |

`MarketCorridor` is dropped (ADR 0019, D-23).

## Alternatives considered

Rejected: Nx (second orchestrator); manifests and `exports` only (no machine check; kept as extra layer); one package (nothing keeps `domain` pure); finer split (areas call each other); ports everywhere (hide real switch points); Zod in `domain` (types leak into signatures); migrate in server or worker (gets API secrets); eslint-plugin-boundaries (weaker resolution; fallback); `turbo boundaries` (experimental).

## Consequences

**Positive**: server and worker compute the same numbers; domain tests need no database; web and migrate hold no API secrets.

**Negative**: wiring per app; shapes duplicated; one more tool and fixture tree.

**Risks**: parameters becoming ports (a new port needs a second real adapter and an ADR change); bypass via relative paths or aliases (resolved paths are checked); env-rule bypass via `const { env } = process`, `process['env']` or `globalThis.process` (ESLint matches each; fixtures); an agent weakening rule files (review lists relaxed rules; Simon reads that diff).

## How we check it

- CI job `boundaries` reports on every PR, no path filter: `depcruise apps packages --config .dependency-cruiser.cjs` with a rule per table row, `no-circular`, `domain-no-runtime-deps`, `domain-tests-dev-deps-only`, `domain-testing-only-from-tests`, `fixtures-only-from-tests`. The merge gate is by convention: CI green plus fresh-context review (D-37).
- `packages/domain/tsconfig.json`: `"types": []`, no DOM lib.
- ESLint: `no-restricted-globals` bans `process` in packages; in apps `no-restricted-syntax`/`no-restricted-imports` ban `env` access outside `env.ts`.
- `tools/boundaries/fixtures/`: one failing file per rule; a script checks each reports exactly its rule.
- One contract suite per port runs on every adapter; Browse only in the manual contract environment (ADR 0011). Type tests: enums, `DomainJob` queue entries.
- PR template: new port, package, app or domain dependency? Link the ADR.

## Revisit when

- A ledger adapter is designed, or Telegram is built or dropped (`Notifier` may become a module).
- First-party Claude inference is rejected (D-18): add a regional endpoint `ListingEvaluator` adapter.
- A sector needs nested attributes (Zod), `ops` needs more secrets, or a second developer joins.
- `turbo boundaries` is stable, or CI typecheck time grows.
