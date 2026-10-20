# Phase 2: fair value and tiers, backups and recovery drill

Status 2026-10-19, proposed. Owner: Simon Klimaszyk (D-01), building alone with Claude Code. Decisions: [../02-decisions.md](../02-decisions.md). Method: [ADR 0017](../../adr/0017-fair-value-and-tier-assignment.md). Backups: [ADR 0025](../../adr/0025-backups-and-restore-drill.md).

## 1. Goal

Deals and alert emails show how cheap a listing is against the current eBay.de market, not only the watch maximum. The stack can be recovered onto a fresh host within the 4-hour RTO ([ADR 0012](../../adr/0012-hosting-and-deployment.md)), measured.

Anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use.

**Outcome at exit**

1. A nightly `fair_value` snapshot per asking-price segment from a complete, unfiltered refresh sweep: weighted median of fixed-price asks, effective sample size (neff), quantiles, interval half-width, calibration flag. Segments with neff below 8 or half-width above 0.15 are Unrated with a reason ("Unrated: neff 5 below 8"); see AC-18. User-max sectors get none.
2. Deals and emails show the tier (No-brainer, Good, Fair, Above market, Unrated), reference, discount, "asking-price based" and "not calibrated". Tiers only label and sort.
3. Ops shows per segment snapshot age, neff, exclusions, truncations, calibration; last verified backup and drill.
4. A timed recovery drill onto a fresh host.
5. Runbooks: `host-loss.md`, `disk-full.md`, `failed-migration-and-rollback.md`, `secret-rotation.md`, `fair-value-off-and-purge.md`.
6. Supply and recall report `docs/reports/phase-2-supply.md`.

## 2. Entry criteria

- Gate 1a passed: a live `EBAY_DE` search returns EUR ([ADR 0003](../../adr/0003-ebay-licence-gates-and-evidence-standard.md)).
- Phase 1 go-live done; S9 may still run ([phase-1.md](phase-1.md)); the base items below are live.
- Phase 0 actuals recorded and the [roadmap](../03-roadmap.md) recalibrated; ADR 0011 accepted (Phase 0 S1).
- Pricing decisions D-21, D-22, D-27, D-28 and ADR 0017 accepted; D-25 thresholds recomputed or shipped as provisional config v1.

**Base items from Phase 0/1** (missing ones go into P2-1 first, +1.5 to 2.5 eng-days):

1. Compose: log rotation (json-file `max-size` defaults to unlimited), memory limits, worker `stop_grace_period` 180 s (default 10 s).
2. Item queues: `deleteAfterSeconds` 3,600, `retentionSeconds` 21,600 (pg-boss defaults 7 and 14 days), `maintenanceIntervalSeconds` lowered from the 1-day default; only surrogate keys in payloads.
3. Nightly backup per ADR 0025: a systemd timer runs `docker compose run --rm backup` (image `FROM postgres:18.6-trixie`, no Docker socket); age-encrypted, with sentinel, allowlist and heartbeat.
4. Bucket in a separate account or project from the host, versioning on, object lock decided at creation. Put-only upload key on the host (GET, LIST, DELETE fail), list-only verify key off the host, drill key (`s3:GetObject` + `s3:GetObjectVersion`) in the password manager.
5. Dump role `backup_dump` without SELECT on `ebay_live` (fallback `--exclude-schema=ebay_live` plus a CI-built schema file); `pg_dumpall --globals-only --no-role-passwords` in the same archive.

**ADR amendments:** 0012 allows the backup image as a second image; 0009/0014 reconcile `manual_anchor`; 0024 adds `refused_count` to `api_usage_hourly`.

## 3. Scope

**In**

- Method fv-1 in `packages/domain/src/pricing`: eligibility (FIXED_PRICE, not AUCTION, no item group; Best Offer at full weight, share stored), age weights from `itemOriginDate`, cleaning, weighted quantile, neff, spread, interval, ratio, `assignTier`.
- neff is the Kish effective sample size, (sum of weights)² / sum of squared weights: how many equally weighted listings the sample is worth.
- Spread is weighted MAD × 1.4826. If the MAD is 0 (say, identical RAM kit prices), it falls back to 1.2533 × the mean absolute deviation; if that is also 0, the outlier cut is skipped.
- If the ADR 0013 seller switch reads `seller.username`, variant `fv-1-capped` caps each seller's weight in memory. The username is never stored.
- Worked-example table recomputed from `fixtures/pricing/rtx3090-example.json`.
- `refreshSnapshots` use case; eBay calls go through a `ListingSource` port and time through an injected `Clock`, so tests need no network. The handler writes `refresh_run` and `fair_value`. Query: feed category and `q`, `deliveryCountry:DE,itemLocationCountry:DE`, `buyingOptions:{FIXED_PRICE|BEST_OFFER}`, no price filter, up to 10 pages.
- The flag `licence-layers.fairValue` is only an on/off switch for the layer, kept for the purge runbook.
- `manual_anchor` (`source` = `ebay_sold` | `external`), form on Watches, audit rows without numbers.
- Decision rows store `fair_value_id`, config version, risk-adjusted cents, z, tier and shadow route.
- Display behind `pricing.display`. Tier input is the gross landed price plus the D-25 risk premium for sellers without returns (company profile: any seller; private profile: private sellers).
- Price columns on `fair_value`, tier inputs and `ebay_sold` anchors are nulled at day 30; with dumps kept 17 days, a price lives at most 47 days. `external` anchors stay until deleted.

**Out of scope:** price check, on-demand recompute, routing by tier, market check (D-23), Claude screening ([phase-3.md](phase-3.md)), auctions, backtest and poll interval (Phase 5), `price_observation`, pooled segments, item-group expansion, EU-wide filter, staging host, history beyond 30 days, a "moving" flag. Any addition needs a written change to this plan.

## 4. Tiers and routing (D-45)

Until slice 3 the route stays Phase 1's `decideSlice1`, unchanged. A shadow route (instant for No-brainer and Good, digest for Fair and Above market) is stored, never acted on.

## 5. Slices

Engineer-days without agents. Each PR needs green CI and a fresh-context review; Simon reads `infra/`, `.github/`, `scripts/` and `docs/adr/` diffs and gives the go per deploy.

| # | Slice | Depends on | Est. |
|---|---|---|---|
| P2-1 | Allowlist and sentinel cover the pricing tables; `scripts/price-age.sql`; daily GitHub Actions verify job (repository secret): newest object under 26 h, within 50% of previous size, no version over 17 days | Phase 1 | 1 to 1.5 |
| P2-2 | `refresh` queue: `retryLimit: 1`, `retryDelay: 1800`, `expireInSeconds` above timeout; SIGTERM test; previous release runs on the new expand-only schema | ADR 0015 | 1 to 1.5 |
| P2-3 | Runbooks, `infra/compose.restore-drill.yml`, recovery drill, heartbeat drill | P2-1 | 2.5 to 3.5 |
| P2-4 | fv-1 test-first, both seller-switch states, fixture, fast-check for `assignTier`; no I/O | D-21, D-22 | 4.5 to 6.5 |
| P2-5 | Nightly cron per feed (Europe/Berlin, outside hour 2, staggered, `singletonKey = feed_id`) when the flag is on; each page reserved via the ADR 0007 counter; day-30 null-out; Ops panel | P2-4, D-27 | 4 to 5.5 |
| P2-6 | Anchors with audit in one transaction; ratio needs at least 10 sales, at most 30 days old, 1 to 1.5 | P2-5 | 1.5 to 2.5 |
| P2-7 | Snapshot selection (newest swept before `first_seen_at`, at most 48 h old); decision columns; display; emails; replay; `pricing:purge` | P2-5, D-28 | 3 to 4 |
| P2-8 | Activation PR flips the flag; contract test; display on after the 28-day review; 7-night report | P2-7 | 1 to 1.5 |

Two file-disjoint agent streams: A = P2-4, 5, 7; B = P2-1 to 3, then P2-6. One stream at a time owns migrations and the Ops route; Simon edits `.github/workflows/`.

## 6. Acceptance criteria

**Operations**

- **AC-1** 7 nights of verify-job and host heartbeat pings. A wrong upload key gives no host ping, ops mail, missed `backup-verified`. Upload key cannot GET/LIST/DELETE; verify key cannot GET.
- **AC-2** `pg_restore -f -` output lacks `ebay_live` sentinels, holds a known `app` row and a seeded `fair_value` row; globals without passwords.
- **AC-3** (fresh-host case of the ADR 0012 RTO) Step 1, restore mode: no worker or notifier (`RUN_MODE=restore-drill`); `extra_hosts` maps eBay, Anthropic and SES to `0.0.0.0`; nothing to migrate, `ebay_live` and `pgboss.job` empty, counts and key fingerprint match, `/healthz` OK. Step 2, planned failover in a quiet window: at T0 the old worker is stopped with the kill switch. The old host answers the deletion endpoint until DNS moves, then stays off 24 hours before it is retired. Simon runs the timed steps alone from the `host-loss.md` text, with no agent session: host, Traefik route, secrets (age and item-hash keys), image, restore, DNS (TTL 300), correct deletion challenge hash, first poll. At most 4 hours. Missed alerts are accepted; deviations are logged as runbook defects.
- **AC-4** No raw item ID in job or dead-letter tables; refresh jobs carry only `{ feedId, sweepId }`; completed refresh jobs past `deleteAfterSeconds` are gone after one maintenance run.
- **AC-5** SIGTERM mid-sweep: no row, `truncated` = `shutdown`; retry writes one row per segment or keeps the old.
- **AC-6** Runbooks checked against the scripts by a fresh-context review and walked through by Simon.
- **AC-7** Compatibility test green. **AC-8** Heartbeat drill (stop worker, pause probe) logged in `docs/runbooks/heartbeats.md`.

**Fair-value layer**

- **AC-9** Flag off: zero `fair_value` rows, no cron, no refresh-shaped request (MSW), no tier rendered. In production before activation, SQL finds 0 `fair_value` rows and 0 eBay-sourced anchors.
- **AC-10** Golden tests from the fixture. Properties: one tier per input; a lower price never gets a worse tier; uncalibrated is never No-brainer; a failing gate gives Unrated. Sector test (half-lives 14 and 7 days): one snapshot per segment; a user-max module gets none and no refresh calls.
- **AC-11** Nightly replay of decision rows under 30 days: 0 mismatches in CI and over 7 production days; rows with nulled inputs skipped and counted.
- **AC-12** No `seller_username`/`seller_id` column; a sentinel username is in no table, log or trace.
- **AC-13** Injected Clock across the end of CEST: price columns NULL at day 30, codes and tiers kept, anchor `audit_event` rows hold no numeric value; production SQL for older prices returns 0.
- **AC-14** Tier, reference, discount, labels and as-of time show only with `pricing.display`; snapshot test per tier and Unrated reason.
- **AC-15** Property: with `claudeScreening = false`, the route equals `decideSlice1`'s for every input and `buyer_profile`; No-brainer above the maximum gives no alert.
- **AC-16** Page 6 of 10 failing (429, 5xx, timeout, breaker) gives `truncated`, no snapshot, ops mail; refusing page 4 gives `budget_refused`; attempt plus retry use at most 20 calls, all shown by the counter; a 49-hour-old snapshot gives `stale`; flag off unregisters the cron; `pricing:purge` removes pricing data.
- **AC-17** ADR 0006 import-graph check green.

**After activation**

- **AC-18** 7 nights: each segment with eligible listings has a row or an Unrated reason (neff below 8, half-width above 0.15, truncated, stale, no listings); all rows from `refresh`, no price filter.
- **AC-19** Report the Phase 1 instant alerts the shadow route would demote and how many were bought (no threshold).
- **AC-20** Oldest object version restored; no price older than 47 days; no object version older than 17 days.
- **AC-21** Refresh calls have their own label; total at most 80% in every eBay window for 7 days; `alert-path` `refused_count` 0.
- **AC-22** Supply report: measured figures, AC-19, advice on D-25, D-26 and slice 3.

## 7. Test strategy

- Domain tests first for every ADR 0017 definition (age weight `0.5 ^ (age_days / halfLifeDays)`, MAD fallback, poisoning for both switch states), selection and the DST boundary.
- Integration on Postgres 18 with MSW: refresh, AC-16 paths, purge, replay, anchor audit rollback, sentinel. Manual contract run: at most 30 calls. Playwright: 3 flows.

## 8. Risks

| Risk | L | I | Mitigation |
|---|---|---|---|
| eBay revokes keyset or suspends accounts | Medium | High | Flag, purge runbook, 30-day cap |
| Load on the shared host delays jobs | High | Medium | Staggered sweeps, stale gate, heartbeats |
| Host disk fills up | High | High | Log rotation, dump streamed off host, `disk-full.md` |
| Age or item-hash key lost | Low | High | Fetched in every drill; offline age key copy |
| Host compromise deletes backups, or backups leak eBay data | Low | High | Put-only key, versioning, separate account, off-host verify; `ebay_live` excluded (AC-2) |
| Put-only policy blocks rclone multipart uploads | Medium | Medium | Test on the real bucket; fallback `s3:Put*` (no read, list, delete) |
| 30-day cap removes Phase 5 backtest data | Medium | Medium | Backtest within 30 days or on codes and tiers (D-28); Phase 5 plan says so |
| Sweep hits the 10-page cap (2,000 items) | Low to medium | Medium | No snapshot, ops mail; narrow `q`, costed through the budget first |
| Stale snapshot in fast moves (DDR5 up about 5.6 times since July 2025) | Medium | Medium | 48-hour gate; tiers do not route |
| Drill misses alerts or eBay notifications | Medium | Low | Quiet window; old host answers until DNS moves |
| Tier labels sway the 28-day review | Medium | Medium | Display only after the review date |
| Thin supply or no anchors | Medium | Medium | Measured (AC-22); uncalibrated max Good |
| Drill over 4 hours | Medium | Medium | Script the slowest step or revise the RTO |
| Agent speed unmeasured, calendar wrong | High | Medium | Recalibrate from Phase 0 actuals |

## 9. Exit gate

1. In-scope ACs pass (AC-18 to AC-22 after activation).
2. Every PR had green CI and a fresh-context review; release commit green on main (run URL).
3. Deployed on Simon's go; `https://deals.intra-ai.de/healthz` OK.
4. 7 nights of verified backups and snapshots; drill at most 4 hours with step times.
5. ADRs, runbooks and report merged.
6. Simon signs off whether the layer and `pricing.display` are on.

## 10. Estimate

18.5 to 26.5 eng-days, 23 to 36 with a 25 to 35% buffer, plus 2 to 3.5 if base items are missing; reference calendar 5.5 to 8 weeks, Claude Code figure from Phase 0 actuals. P2-4, 5 and 7 are sequential (11.5 to 16 days). Fixed waits: 28-day review date (display only), 7 nights, drill (half to one day), anchors (1 to 2 hours per segment).

**Unverified:** Seller Hub sold ranges; put-only key with rclone; `pg_dump` locks on data-excluded tables; bucket and server provider; DDR4/DDR5 leaf split.

**Sources:** https://developer.ebay.com/api-docs/master/buy/browse/openapi/3/buy_browse_v1_oas3.json, https://pgboss.io/api/queues, https://pgboss.io/api/constructor, https://www.postgresql.org/docs/18/app-pgdump.html.
