# ADR-0024: Logs, metrics, Ops page and ops mail

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0005, 0006, 0007, 0008, 0011, 0012, 0013, 0014, 0015, 0016, 0018, 0019, 0022, 0023, 0030 (heartbeats, probe), D-24, D-34, D-35, D-37, D-48

## Context

- One person runs it on a shared, overloaded host (ADR 0012), which also caps Docker `json-file` logs at 20m by 5 files (https://docs.docker.com/engine/logging/drivers/json-file/). Size-bound rotated logs can outlive a 24-hour listing row (ADR 0014).
- pino redaction uses key paths, `remove: true` deletes, wildcards cost more (https://github.com/pinojs/pino/blob/main/docs/redaction.md). 10.4.0 (2026-10-02) passes ADR 0005's 7-day release age.
- ADR 0018 keeps Langfuse (OpenTelemetry) to evals (D-35). Dependencies are one argument object, like the Clock (ADR 0008).

## Decision

We log with pino as JSON to stdout; logs never hold listing content, seller fields, raw eBay item IDs, prompts or model output. Metrics are Postgres tables in `app`, shown on a read-only Ops page; conditions mail Simon through SES (D-48). Version 1: no OpenTelemetry in production, no Sentry, no off-host logs.

| Item | Rule |
|---|---|
| Logger | `pino@10.4.0` pinned in `packages/logging`; it imports no workspace package, only `pino`. Base fields `service`, `sha`, `run_mode`; `info` in production; `err` keeps `type`, `message`, `code`, `status`, `stack`, Anthropic `request_id`, drops `response`, `body`, `headers`, nested `error` |
| Wiring | Only apps (`server`, `worker`, `ops`) import it. `domain` declares a type-only `Logger` with no runtime code. Adapters and use cases get `log: Logger` in their dependency object; pure functions return reason codes, not logs |
| Log lines may hold | surrogate IDs, queue, route pattern, status, duration, eBay error IDs, Claude `stop_reason` and token counts, reason codes, user ID (never email). Never: OTP codes, cookies, auth headers, the probe code |
| Redaction backstop | `seller`, `title`, `shortDescription`, `description`, `image`, `itemWebUrl` (each also `*.`), `additionalImages`, `data.username`, `data.userId`, `data.eiasToken`, `req.headers.cookie`, `req.headers.authorization`, with `remove: true`. Primary control: eBay objects never reach the logger |
| Metric tables (writer, kept) | `api_usage_hourly` (same statement as the ADR 0007 reservation, 1 y), `poll_run` (poll job, 30 d), `quota_snapshot` (worker every 15 min, 90 d), `funnel_hourly` (each stage, in the transaction recording its result; outcomes include `refusal`, `max_tokens`, `parse_failure`, `timeout`; 1 y), `llm_spend_hourly` (evaluator adapter, micro-dollars, 1 y), `ops_alert` (`ops-alerts` job, 1 y). No eBay content, no prices |
| Derived views | refusal rate per feed from `funnel_hourly`; label backlog is a query over the ADR 0019 review queue; indexing delay `first_seen_at - item_creation_date`, p50/p95 over 7 days, relists apart; Berlin Claude budget day from `llm_spend_hourly` |
| Ops page | read-only (D-24), `GET /api/ops` (Zod contract, SQL views in `packages/db`), reloads every 60 s, no buttons; shows the time of the last `probe_seen` row. Redrive is a CLI over SSH, logged to `audit_event` |
| Ops mail | worker job `ops-alerts` every 5 min; a pure function returns open conditions; one mail on open, one on close; after 20 per Berlin day, conditions show only on the Ops page. Rules in `packages/domain/src/ops/rules.ts`, thresholds owned by their ADRs, each with a section in `docs/runbooks/ops-alerts.md` |

Phases: 0 logger and log rules; 1 first five tables, Ops page, `ops-alerts`; 3 `llm_spend_hourly`, refusal and label-backlog rules.

Starting rules (informative; changed in `rules.ts` under the owning ADR): eBay quota above 90% of the window, page cap reached in the last hour, feed breaker open 15 min (0016); Claude day budget used up, more than 3 refusals per feed per Berlin day (0019); claim or delivery anomalies non-zero for an hour, any dead-letter job (0015); any `inference_geo` mismatch (0018); deletion results only `key_unavailable` for 6 h (0013); shadow or blocked items unlabelled after 4 h, so a reviewer sees content before the 6-hour purge (0019, D-34). Restore-drill age has no ops rule; the ADR 0011 healthchecks check watches it.

## Alternatives considered

OpenTelemetry with Prometheus, Loki, Grafana (more containers on an overloaded host, span attributes leak); Sentry (stack frames carry listing text out); Langfuse in production (ADR 0018 keeps it to evals); off-host log shipping (another processor; facts are in Postgres and the dump).

## Consequences

- Positive: metrics are plain SQL in the same database and backups; a test proves logs hold no eBay content.
- Negative: no traces; logs die with the host, hold days to weeks; six tables, a job, a rule file.
- Risks: an error leaks a title or seller (`err` serializer, redaction, sentinel test); ops mail floods the mailbox or SES quota shared with login codes (open/close only, cap); metric writes slow the hot path (single-row upserts in existing transactions).

## How we check it

- Sentinel test (ADR 0023): sentinels in title, description, image URL, item ID, `seller.username`, an Anthropic SDK error and an eBay 500 never reach pino output.
- Lint `no-console`; dependency-cruiser `logging-only-from-apps` (`packages/ebay` importing it fails); `@opentelemetry/*`, `@langfuse/*`, `@sentry/*` only in `evals/`.
- Schema test: no metric column like `title`, `description`, `seller`, `url`, `price`; timestamps `timestamptz`.
- Unit tests: each rule opens and closes once; cap holds; every rule has a runbook heading; relists excluded from p50/p95.
- Compose test (ADR 0012): every service sets `max-size` and `max-file`. Review (D-37) rejects logging an eBay or Claude object.

## Revisit when

More than one host or a split worker; logs from a lost host needed, or rotation too short; errors outgrow pino plus ops mail (reconsider Sentry with scrubbing); a new ADR allows Langfuse in production.
