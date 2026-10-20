# ADR-0023: Testing strategy

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0005, 0006, 0008, 0011, 0013–0017, 0019, 0022, 0025, 0026; D-04, D-17, D-24, D-37; [company vs private](../planning/guides/company-vs-private.md)

## Context

- Recorded eBay responses in `fixtures/` (the plan) outlive 0014 retention and carry `seller.username`/`seller.userId` ([Browse OpenAPI v1.20.4](https://developer.ebay.com/api-docs/master/buy/browse/openapi/3/buy_browse_v1_oas3.json)).
- A crash after a paid Claude call can repeat it; the 0015 claim row needs a crash-replay test.

## Decision

Domain code is test-first with Vitest 5, golden fixtures and fast-check 4 properties. eBay fixtures are synthetic, built from Zod schemas checked against the pinned Browse OpenAPI file, regenerated in CI. Anything with a transaction or lock runs on real Postgres 18. Real eBay and Claude: manual contract run only (0011). Playwright covers 3 flows. Versions follow 0005; screener evaluation is 0026.

| Layer | Tool | Against | Runs |
|---|---|---|---|
| Unit, golden, property | Vitest, fast-check | pure functions, `Clock` (0008) | scoped local, affected PR, all `main` |
| Adapter | Vitest, [MSW 3](https://github.com/mswjs/msw/releases/tag/v3.0.0) `onUnhandledFrame: 'error'` | synthetic eBay, Anthropic responses | same |
| Integration | Vitest | Postgres 18, template database per file | same |
| Retention sentinel | Vitest | Postgres 18, backup script (0025) | PR touching `db`, `worker`, `ebay`, `llm`, `notify`, `infra/backup`; `main` |
| End to end | Playwright, Chromium | CI image, fixture `ListingSource`, log `Notifier` | PR touching `web`, `server`, `contracts`; `main` |
| Contract | Vitest, tag `contract` | production keyset, Claude | manual only |

1. **Golden values** live in `fixtures/` (0017 pricing example, 0016 budget figures, the four `effectiveMaxBid()` rows, net 5% = EUR 559.68) and come from an independent script in the same PR, not the implementation.
2. **Properties** (100 runs on PR, 1,000 on `main`): one tier per input, monotone in price; a feed plan stays ≤ 0.8 × the eBay limit, alert floor and Price check cap held; the governor never plans more than `remaining` before `reset_at`; a `buyer_profile` what-if (D-04) never changes the stored alert decision, tier or verdict, and writes nothing.
3. **Synthetic eBay fixtures**: builders in `packages/ebay/src/testing/` use a fixed fake ID range; every file in `fixtures/ebay/` comes from `pnpm fixtures:build`. Cases: 250-item paging with a malformed item, item groups, 429, 5xx, token expiry, `warnings`, classifier traps (3090 Ti, 4090 D, laptop, "nur OVP"). No sandbox adapter; no OpenAPI codegen (`openapi-typescript` peers TS 5). The pinned OpenAPI file (v1.20.4) is committed, SHA-256 checked. Anthropic fixtures (SDK-typed): refusal, `max_tokens` stop, invalid JSON, model mismatch (0019).
4. **Real Postgres**: polls of one feed never overlap; one claim key, one evaluator call; SIGKILL of `send` or `evaluate` after the paid call, then a fresh worker, gives exactly one paid call and at most one duplicate delivery; migrations apply from empty; the deletion endpoint answers with the database stopped (0013).
5. **Retention sentinel**: seller, text and item-ID sentinels go through the pipeline, with a malformed item and an evaluator failure. Seller sentinels appear nowhere (full `pg_dump`, pino, telemetry, rendered messages, Claude requests); text and item IDs never in `pgboss` or logs, in messages only where 0022 allows; after the purge, nowhere in the database.
6. **Playwright flows**: sign in with a code from the log `Notifier`; create a watch; confirm a feedback link by POST (the GET changes nothing). A fourth flow updates this ADR (D-24).
7. **No network outside the contract run**; CI has no eBay or Anthropic secrets.
8. **Contract run asserts and discards**: `getRateLimits` first, under the 100-call cap (0011), each 0016 query shape checked for empty `warnings` and Zod validity, the Claude output schema sent once with a synthetic case, calls and cost printed, no response body stored.

## Alternatives considered

- **Recorded production fixtures (plan)**: eBay content and seller names in every clone, against 0014.
- **Hand-written JSON with a "synthetic" marker**: a pasted response passes once marked.
- **Mocked Postgres**: lacks the locks and rollbacks 0015 needs.
- **nock**: Node only; MSW also covers web.

## Consequences

**Positive**: rules fixed before code; each leak path has a test.

**Negative**: slower Postgres and crash-replay tests; real quirks missed until a contract run; each fixture needs a builder definition.

**Risks**
- Pino redaction misses a new field: the sentinel test catches it.
- MSW 3 may not intercept the AWS SDK (unverified; confirm in Phase 0, else SES is checked by contract run only).
- `fixtures-scan` catches accidents, not deliberate copies; regenerate-and-diff is the guarantee.
- Solo work (D-37): the fresh-context review lists removed, skipped or weakened tests and changes to Vitest, Playwright, fast-check, MSW or fixture-build config, `evals/`, `turbo.json` and `package.json` scripts; Simon reads those diffs before merge.

## How we check it

- PR CI: `turbo run test --affected` and `boundaries` (0006); `main`: all tests, sentinel and Playwright suites. A failing fast-check seed lands as a regression test in the fixing PR.
- Lint: only test files and the fixture adapter import `fixtures/` (0006).
- `fixtures-generated`: rebuilds to a temp folder, fails on any diff or extra file in `fixtures/ebay/`.
- `fixtures-scan`: fails on an item ID outside the fake range or an `ebay.de`/`ebayimg.com` URL.
- A test asserts an unmocked request fails; the contract run fails on a Zod field absent from the pinned OpenAPI file.

## Revisit when

Integration or crash-replay tests flake more than weekly on `main`; a contract run finds the same uncovered quirk twice; a new Vitest, MSW or Playwright major; a fourth flow.
