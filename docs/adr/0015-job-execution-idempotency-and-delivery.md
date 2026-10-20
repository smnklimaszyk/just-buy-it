# ADR-0015: Job execution, paid-call claims and at-least-once alert delivery

**Date**: 2026-10-19 · **Status**: proposed · **Deciders**: Simon Klimaszyk
**Related**: ADR 0005, 0006, 0009, 0012, 0014, 0016, 0019, 0020, 0023, 0024, 0028, 0031, 0032; D-31, D-48
**Amends**: ADR-0014 (payload rule moves to A); ADR-0006 (`inTransaction` variant dropped); catalogue ("landed-price drop or better tier"; alert "references its decision").
**Size**: about 8 KB, over the 6000-byte budget, because the queue registry, alert enums and claim rules are defined only here.

## Context

- A key checked after a Claude call stops duplicate rows, not spend; SIGTERM drain misses SIGKILL, OOM, crashes.
- pg-boss 12.38.0: policies apply per `singletonKey` (`plans.ts`), are fixed at creation, `send()` may return `null` ([queues](https://pgboss.io/api/queues)); an expired handler may run on ([workers](https://pgboss.io/api/workers)); `fromDrizzle` enqueues in our transaction ([adapters](https://pgboss.io/api/adapters)).
- Anthropic SDK retries twice by default (assume timeouts billed); SES has no idempotency token.

## Decision

All jobs go through pg-boss 12 behind one typed wrapper, no transactional workers; a job following a domain write is enqueued with `fromDrizzle` in that transaction. Each Claude call and SES send needs a committed claim row with a lease and an attempt counter as fencing token (max 3).

**A. Registry** (`packages/db/src/queue`, the only queue list). Payloads: `z.strictObject` of uuids `listingId`, `feedId`, `pollRunId`, `sweepId`, `deliveryId`, `alertId`, `evaluationId`, `auctionCheckpointId`, or `digestKind`; never an item ID or text. All queues: `deleteAfterSeconds` 3600, retention 21600 s unless noted, dead letter `<name>.dead` (pg-boss defaults), timeout < lease < expiry. Cron in UTC unless Berlin.

| Queue | Phase | Trigger | Key | Timeout / lease | Expiry s | Retries |
|---|---|---|---|---|---|---|
| poll-tick, relay | 1 | every minute | - | - | 60 | 0 |
| poll | 1 | poll-tick | feedId | 10 s per page, 3 pages | 120 | 0 |
| cheap-sweep | 1 | poll-tick, hourly | feedId | 10 s | 60 | 0 |
| quota-read | 1 | `*/15` | - | 10 s | 60 | 1 |
| breaker | 1 | delayed, on half-open | feedId | 10 s | 60 | 0 |
| enrich | 1 | decide path | - | 10 s, 8 images | 180 | 2, 30 s backoff |
| decide | 1 | enrich, screening | - | - | 60 | 2 |
| send | 1 | decide | deliveryId | 10 s + 10 s / 45 s | 60 | 2, 30 s backoff |
| recheck | 1 | first `sent`, +1800 s | alertId | 10 s | 60 | 1 |
| digest | 1 | hourly; 21:00 Berlin | digestKind | 10 s / 45 s | 120 | 2 |
| refresh | 2 | nightly per feed | feedId | 10 s per page, 10 pages | 300 | 1, 1800 s delay |
| screen.triage | 3 | enrich | - | 30 s / 45 s | 60 | 2, 30 s backoff |
| screen.deep | 3 | triage | - | 120 s / 150 s | 180 | 2, 60 s backoff |
| screen.confirm | 3 | deep | - | 60 s / 75 s | 90 | 2, 30 s backoff |
| screen.audit | 3 | sampler (ADR 0028) | - | per stage / 150 s | 180 | 1 |
| auction-sweep | 4 | hourly, 19:00 Berlin | feedId | 10 s | 60 | 0 |
| auction-checkpoint | 4 | T-150, T-60, T-15 | auctionCheckpointId | 10 s | 60 | 1 (retention 86400) |

- Database only: skeleton-ingest (CLI, 120 s), purge (phase 0, `*/15`, 600 s), retention-nightly (03:45 Berlin, 1800 s), ops-alerts (`*/5`, 120 s), review-metrics-snapshot (days 14, 21, 28; 300 s; retention 2592000).
- Keyed and cron queues are `exclusive`; enrich, decide, `screen.*` standard (`screen.*` concurrency 1, timings reset in phase 3).
- Redrive: CLI over SSH, writes `audit_event` as `system:cli`; no Ops button.
- `recheck` records if the deal still existed after 30 minutes: sets `alert.recheck_30m_result` only where NULL, alert-path budget (ADR-0016).
- Adapters get `{ timeoutMs, signal }`; `createAnthropicClient` is the only factory (`maxRetries: 0`). No connection held across a call; pool `max` >= sum of `localConcurrency` + 2. Shutdown: graceful 170 s, `stop_grace_period: 180s`.

**B. Claims.** `app.evaluation` unique on (item_key, stage, revision_hash, prompt_version). Hashes: `triage-v1:` landed price, currency, end time, title + shortDescription (`summary_*` only); `deep-v1:` adds description and image hashes (ADR 0031, proposed, may drop price and end time); `confirm-v1:` deep hash, image SHA-256, finding code. `triage-shadow-v1`/`deep-shadow-v1` run on `screen.audit`, enqueue nothing downstream, cause no alert. A paid call needs no `done` row, a better tier, or a >= 5% price drop (max 3 deep per item per 7 days, config); a worse tier never does; text edits go to the free full-text scan (ADR-0020).

The claim transaction also reserves budget (ADR-0019) and writes provenance: none -> `running`; `done` -> reuse; `running` in lease -> exit; stale or `released`, attempt < 3 -> conditional `attempt + 1`; `failed` -> exit. Usage goes to spend in its own transaction. Result write fenced `WHERE attempt = $mine`, with the next enqueue. Error at attempt 1-2 -> `released`, throw. Out of attempts -> `failed`, review entry, `decide` applies the ADR-0019 signal (at least CAUTION, digest only).

**C. Delivery.** `decide`, one transaction: exit if its job ID has a decision; lock listing, then watches by ID; insert `decision` (every outcome, BLOCK too); insert `alert` (unique item_key, kind, tier, checkpoint; better tier only); one `alert_delivery` per channel and recipient, over 3 instant per watch per hour -> digest; enqueue `send`. Enums (defined only here):

- `kind`: band, instant, auction_bid, trial. `checkpoint`: none, t60, t15, digest, last_call.
- `tier`: none, no_brainer, good, fair, above_market, unrated; NOT NULL (NULLs are distinct in a unique key).
- Partial unique index: one auction_bid alert per item, except last_call.
- A listing matching both buyer profiles gets one alert, company profile (owner to confirm).

`send` claims `pending` or stale `sending` (45 s, attempts < 3), rechecks eBay, sends with the delivery ID in `EmailTags` and footer, writes `sent`/`dropped` fenced. SES error -> `pending`; timeout stays `sending` (one duplicate possible). `digest` is unique on (digest_kind, window_start), claims deliveries by setting null `digest_id`, same lease and fencing. `relay` re-enqueues deliveries pending 2 minutes or stale, and evaluations `running` past lease or `released` over 10 minutes; attempt-3 rows become `failed` with ops email or review entry.

## Alternatives considered

One alert table (no digest, recipient or checkpoint tracking); transactional `decide` (Drizzle cannot join pg-boss's transaction); key after the call, drain only or claim inside the call (crashes repay untraced); `stately` `send` (relay races the retry); Redis or a broker (extra service); at-most-once (loses deals).

## Consequences

- **Positive**: max 3 paid calls per key; no alert lost before SES accepts; exhausted claims surface; Telegram adds only rows.
- **Negative**: more tables and the relay; a crash after a call repays; policy change needs a new queue; `screen.deep` caps near 30/hour.
- **Risks**: lease below call time (registry test); price stepping (cap); takeover resends an email; `singletonKey` change (policy test); shared-host load (ADR 0012).

## How we check it

- ESLint: `pg-boss` only in `packages/db/src/queue`, `@anthropic-ai/sdk` only in `packages/llm`. Registry test: timings, retention, dead letters, payload allowlist.
- Factory: HTTP 529 gives one request; hung `fetch` fails at `timeoutMs`. Policy (pg-boss 12.38.0, Postgres 18): second `send` per `deliveryId` returns `null`.
- Crash-replay (ADR 0023): 2 deep jobs, 1 call; repeated throws, max 3 calls then `failed`; kill in attempt 3 + relay, `failed`; late superseded result rejected; killed `send` + relay, 1 SES call; throw after SES accepts, 1-2 calls, never 0; 5 decides per watch, max 3 instant; 2 ticks, 1 poll; 2 digest jobs, 1 digest.
- Ops metrics (ADR 0024): claims over 1 attempt, failed claims, deliveries retried or pending over 5 minutes, dead letters, recheck result. A failure count non-zero for an hour emails Simon (D-48).

## Revisit when

pg-boss 13 or `singletonKey` change; `screen.deep` needs concurrency > 1; Anthropic or SES add idempotency keys; > 2% of claims or > 1% of deliveries retry; a second channel.
