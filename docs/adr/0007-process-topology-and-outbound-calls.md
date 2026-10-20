# ADR-0007: Two processes on Postgres, and which process may call out

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0003, 0006, 0008, 0012-0016, 0021, 0024; D-13, D-37, D-47, D-48

## Context

- The plan said the worker makes every outbound call; three server flows contradict that.
- eBay wants deletion notices acked at once, verified with getPublicKey (`api_scope`, key cached 1 hour), up to 1,500 a day, and marks the URL down after 24 hours unacknowledged ([eBay](https://developer.ebay.com/marketplace-account-deletion)). The Notification API has its own 10,000 calls a day. So the server needs the eBay secret.
- Better Auth sends the login code from the server ([docs](https://www.better-auth.com/docs/plugins/email-otp)); a pg-boss job would keep it 7 days.
- The watch preview is one Browse search page (`limit` 50) held in memory (D-47); Refresh is one getItem.
- pg-boss runs schedules and maintenance on every instance unless switched off ([pg-boss](https://pgboss.io/api/constructor)).
- In-memory counting per process gives two budgets. The 1,000 a day token limit comes from a search summary only, since eBay's page returned 403 on 2026-10-19.

## Decision

One image runs as two Node processes on PostgreSQL 18, no Redis: `server` (Hono API, Better Auth, deletion endpoint, privacy page, SPA) and `worker` (pg-boss schedules and jobs). The server makes only these calls:

| Process | Call | Timeout | Counter | On failure |
|---|---|---|---|---|
| server | SES login code (`hashed`, ADR 0021), not awaited | 5 s | none | log without code |
| server | eBay token, cache empty | 5 s | recorded | flow fails, no unit spent |
| server | getPublicKey, after the 204 (ADR 0013) | 5 s | recorded | log `key_unavailable` |
| server | watch preview, one page | 10 s total | 1 `standard`, user ID | 504, unit spent |
| server | Refresh, one getItem | 5 s total | 1 `standard`, user ID | "details hidden" |
| worker | all else (polls, Anthropic, SES alerts) | ADR 0015 | ADR 0016 class | retry, dead letter |
| one-off container | contract runs | per run | 1 `standard` | stops at call cap |

The server never calls Anthropic, starts pg-boss with `migrate`, `schedule` and `supervise` `false` and only sends jobs; it has no redrive route (CLI over SSH). One `AbortSignal` per request; a unit is reserved only with a token in hand. The preview uses live data only after gate 1a (ADR 0003).

**Counter**: classes `alert-path` and `standard` (ADR 0016). Tables `app.ebay_quota_window` (`limit_total`, 5,000 until the first reading; `used`; per-class used; `ebay_offset`) and `app.ebay_user_window_usage`. `app.reserve_ebay_call(resource, class, purpose, min_left, user_id, user_cap)` returns `ok`, `pool` or `user_cap`: it increments the user row `where used < user_cap`, then the window row `where limit_total - used - ebay_offset - 1 >= min_left`, rolling both back on refusal. Locks go user row, then window row. It raises on a null `user_id` for `watch_preview` and `item_refresh`, and inserts a missing window row aligned to the previous `window_end` (on conflict do nothing), so no process needs the worker's quota job. Purpose tags go to `app.api_usage_hourly` for reporting only. No refunds; Postgres down means Browse fails closed. Every 15 minutes the worker records signed drift from getRateLimits in `quota_snapshot`, then sets `ebay_offset = max(0, drift)`; `used` is never overwritten.

**Tokens**: in memory per process, refreshed 5 minutes before expiry by one in-flight promise, never stored or logged; about 24 requests a day, so only a limit below about 50 matters.

**Amendments elsewhere**: ADR 0013: the server imports only the token, getPublicKey, search and getItem modules; the credential is not narrowed. ADR 0016: the second class is `standard`; the per-user preview cap counts per quota window.

## Alternatives considered

- **One process**: a blocked event loop or worker crash takes deletion and login down.
- **Worker makes every call**: login codes in job rows, deletion depends on the worker, preview results sit in pgboss job rows under their retention.
- **Static per-class allowances**: cannot express ADR 0016's pro-rated floor.
- **In-memory accounting**: two budgets, lost on restart.
- **Redis/BullMQ**: a second stateful service, job state outside the decision transaction.

## Consequences

**Positive**: deletion, login and preview survive a stuck worker; one budget across processes and restarts.

**Negative**: the server holds the full eBay secret; a Postgres round trip per Browse call; two token caches; no per-process egress limit.

**Risks**
- Count drift: `ebay_offset` takes the lower; ops email to Simon (D-48) above 50 calls positive drift per window, a starting value (1% of 5,000) to revisit after two weeks. Negative drift is shown, not alerted.
- Preview drains `standard`: ADR 0016 floor and per-user cap; 10 s deadline, also via `hono/timeout`.
- A notification burst costs one key lookup (cache by key ID, one in-flight fetch).
- Noisy neighbours on the shared host (ADR 0012) delay jobs.

## How we check it

- dependency-cruiser: `apps/server` imports only those four `packages/ebay` modules, never `packages/llm`; only `apps/worker` imports `work`/`schedule`.
- Startup test on the real entry: no `work`/`schedule` calls, three flags `false`.
- MSW `onUnhandledRequest: 'error'` in server tests.
- Class check: preview and Refresh raise `used_standard` and the user's row, not `used_alert_path`.
- Concurrency, two processes: limit 300, `min_left` 100 gives exactly 200 `standard` `ok`, then 150 `alert-path` give 100 `ok`, `used` 300; user cap 40 of 60 gives 40; refusals leave no user increment.
- Reconciliation: `used` 100, reading 150 gives drift 50, `ebay_offset` 50, `used` 100; next `standard` reservation sees `remaining` 50 lower.
- Timeouts: slow search gives 504, unit spent; token timeout leaves `used` unchanged; slow SES does not delay login.
- Postgres stopped: a signed notification still gets 204.
- Fresh-context review (D-37): a new server call needs an amendment here.

## Revisit when

- A new server call, preview p95 over 5 s for a week, a second replica or host, or measured queue or Postgres load.
- eBay changes quota, keysets or getPublicKey auth, or confirms a token limit other than 1,000 a day.
