# ADR-0009: Configuration kinds and decision versioning

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0006, 0011-0015, 0017, 0021, 0026; D-04, D-05/D-06, D-24, D-28, D-37, D-48

## Context

- Only `fair_value` is versioned; no table holds an audit log; `feed` mixes team values with worker breaker state.
- Model IDs are pinned; the 5.5 models retire from 22 Sep 2027 (Opus), 28 Sep (Sonnet), 7 Oct (Haiku) ([models](https://platform.claude.com/docs/en/about-claude/models/overview)). `model`, `stop_reason`, `usage` exist only after a response ([Messages API](https://platform.claude.com/docs/en/api/messages/create), read 2026-10-19), but ADR 0015 inserts a `running` row first.

## Decision

Three kinds, one home each; compliance constants carry `source` (`licence` or `internal_policy`) and are never runtime settings. Every `fair_value`, `evaluation` and `decision` row stores the versions, model, effort, inputs and git SHA that produced it.

| Kind | Examples | Lives in | Changed by |
|---|---|---|---|
| Decision config | Tier bars (0.80 / 0.92, q10 / q20), neff gates (8 / 15), half-lives, risk premium, `buyerProfiles`, rubric points, verdict cut-offs | `packages/domain/src/config/decision.vN.ts` | PR adding a file and moving `ACTIVE_DECISION_CONFIG` |
| Operational settings (audited) | Kill switches, budgets, recipients, quiet hours, products, feeds, watches (`buyer_profile`, default `company`), anchors | `app` tables `setting`, `product`, `feed`, `feed_product`, `watch`, `manual_anchor` | Watches and Feeds screen (ADR 0021) or `ops:switch`, `ops:set --as <user>` over SSH (D-24) |
| Compliance limits | List below | `packages/domain/src/compliance-limits.ts` | PR |
| Deployment wiring | Database URL, API keys, `GIT_SHA` | Zod env schema (ADR 0011) | Deploy |

Compliance limits, kept under the owner's accepted risk (D-05/D-06) to limit exposure:
- `listing`, `listing_content`, `evaluation_quote` purged once `gone_at` is set, no grace period.
- Gone: getItem ended or not found, end date passed, missing from two consecutive complete sweeps, or 48 hours unconfirmed.
- Rows unconfirmed for 48 hours leave the fair-value sample.
- Content window 6 hours after fetch; as-of time on every display; at most 80% of the eBay call pool.
- Price-bearing columns nulled 30 days after write (table below).
- Deletion endpoint: 64 KB body cap, public key cached 1 hour (ADR 0013).

Rules:
- A merged config version is never edited; switching is one PR and one deploy on Simon's go (ADR 0012).
- Any decide-code change, refactors included, bumps `DECISION_LOGIC_VERSION`.
- Rubric, prompt, model or effort changes run the evaluation set (ADR 0026); a new model runs in shadow first.
- Env vars and the CLI never change a bar, rubric point or compliance limit.
- The private/company what-if (D-04) writes nothing.
- `app.audit_event` (actor, entity, old, new); actor is a user ID, `system:cli` or `system:migrate`. A trigger on audited tables fails without `app.actor`; another blocks `UPDATE` and deleting rows under 1 year old. Audited tables hold no eBay content.
- Worker state: `feed_state`, `guard_state`; guard changes go to ops mail (D-48).

| Record (lifetime) | Provenance (`NOT NULL`) | Inputs |
|---|---|---|
| `fair_value` (1 year) | method, config, classifier versions, `git_sha` | raw median, n per step, neff, quantiles, `anchor_id` |
| `evaluation` (180 days) | prompt, schema, rubric versions, `model_requested`, `effort`, `git_sha`; when `done` (CHECK): `model_returned`, `stop_reason`, tokens, cost | finding codes |
| `decision` (180 days, every outcome, unique on decide job ID) | config, rubric, classifier, logic versions, `git_sha`, `valuation_mode`, `watch_id`, `evaluation_ids`; `CHECK (valuation_mode = 'max_price' OR fair_value_id IS NOT NULL)` | landed and basis cents, `price_basis`, `vat_class`, `buyer_profile`, max price, points, tier, verdict |

- A refusal or `max_tokens` stop still reaches `done`; `inference_geo`, `service_tier` stay nullable; a takeover refreshes `git_sha`.
- `model_returned` differing from `model_requested` is counted on the Ops page and treated as a refusal.

| Record | Nulled at 30 days | Kept |
|---|---|---|
| `fair_value` | `raw_median_cents`, medians, quantiles, interval bounds, ask-to-sold ratio | provenance, n, neff, `anchor_id` |
| `evaluation` | none | all |
| `decision` | `landed_cents`, `basis_cents`, `z` | provenance, `max_price_cents`, points, tier, verdict |

`alert` gains `decision_id NOT NULL` (ADR 0015). `backtest(records, config)` is pure and replays records with the current logic version and non-null prices.

## Alternatives considered

Config rows in a Settings screen (second promotion pipeline), env vars (untyped, unversioned), a feature-flag service (infrastructure for one user), auditing every table (machine writes drown edits), a `fair_value_input` table (keeps prices after the listing is gone).

## Consequences

**Positive**: every alert traces to config, logic, rubric, prompt, model and commit; a model retirement is a routine config version.

**Negative**: each threshold change needs a PR and deploy; about 30 extra columns, two state tables, two triggers; a logic bump drops older records from replay; backtests only tighten bars (D-28).

**Risks**: wrong `GIT_SHA` (env schema requires 40 hex chars); a new team table without the trigger (schema test).

## How we check it

- `config.lock.json` holds SHA-256 of each config version, of decide code keyed by logic version, and of each fair-value method. Vitest fails on changed hashes; a CI step fails when an entry differs from `main` (adding one is allowed). CI green before merge (D-37).
- Schema test (Postgres 18): provenance `NOT NULL`, price columns nullable, both CHECKs exist.
- Retention: day 30 nulls the listed columns only; a day-29 row is untouched.
- Audit: no actor fails; with actor gives one `audit_event`; worker state writes give none.
- Replay: `backtest` with each record's own config reproduces tier and verdict; a weekly job shows skips and mismatches on the Ops page.
- Property test: `buyer_profile` never changes a tier.
- No settings key matches a compliance constant.

## Revisit when

- Simon chooses to change the 30-day nulling, or wants loosening backtests (D-28).
- Config changes more than weekly, merge-to-running exceeds an hour, a second marketplace or third sector arrives, or more than about 5 users.
