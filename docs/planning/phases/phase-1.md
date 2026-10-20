# Phase 1: max-price email alerts (slice 1, F1)

Status 2026-10-19: proposed, nothing built. Simon builds alone with Claude Code (D-01). See [decisions](../02-decisions.md), [ADRs](../../adr/README.md).

## 1. Goal

Ship the smallest product that can lead to a purchase; a 28-day review checks whether it beats eBay's saved-search emails (D-07). Price check dropped (D-47). A person buys through eBay checkout; no bidding or buying automation (gate 3, ADR 0002).

At exit Simon can: sign in on `https://deals.intra-ai.de` with a 6-digit email code (seeded users); create products (GPU, RAM) and watches with floor, maximum landed price in EUR and `buyer_profile` `company` (default, compared gross) or `private` (D-04, [guide](../guides/company-vs-private.md)); assign feeds within 80% of the call limit; get instant alerts (in band, rules and recheck passed; only with `alerts.instantUnscreened` on: D-09 is decided, digest by default, `alerts.instantUnscreened` false) and an hourly digest (over 3 per watch per hour, below floor, red flags); use Deals with a never-stored company/private what-if and D-50 feedback; read Ops tables; run the review on M1 to M5 (thresholds under S8 rules).

Every email: "not reviewed by Claude", profile line, reason codes, seller numbers without identity, text-based VAT flags, as-of time with zone, arrival checklist for the profile.

## 2. Entry criteria

**From [phase-0.md](phase-0.md)** (gaps add 2 to 3 days): monorepo and migrate step (pg-boss `migrate: false` from phase 0 S4); CI with Postgres 18, SHA-tagged deploys with rollback on `intra-ai` (`/opt/ebay-sniper`, Traefik, 127.0.0.1:3140); deletion endpoint, `/privacy`, probe; keyset active, gate 1a passed ([guide](../guides/ebay-access.md)); query builder, fixtures (Browse OpenAPI v1.20.4), first contract run; supply counts (D-20); SES `alerts.intra-ai.de` verified, production access requested; [secrets](../environments-and-secrets.md); owner checklist: input tax (`inputTaxDeductible` false until confirmed), legal form, business eBay.de account.

**Decisions still needed:** D-27 before S1; D-11, D-16, D-50 before S2; D-20, D-26 before S4; D-24 before S6; D-08 before S8; D-56 before S10.

**ADRs:** those placed before Phase 1 are Accepted. Amend first: buyer profile fields in 0009, 0010, 0013, 0020, 0022, 0027; ADR 0005 pins `react-email` 6.x (`@react-email/components` deprecated) and replaces the deprecated `@better-auth/cli` step; pins respect the minimum release age.

## 3. Scope

**In:** S1 to S9 below; S11 after the first alert.

**Out:** fair value, tiers, sold anchors, refresh sweep (Phase 2); Claude screening, seller-scoped signals, D-15 (Phase 3); seller-type outputs from `sellerAccountType` (field stored now; off in slice 1 for a clean baseline): private-seller premium on with tiers in Phase 2 (D-25), seller-returns rules including `business_no_returns` in Phase 3a (ADR 0027, D-45, D-63); auctions, D-36 (Phase 4); market check, D-23 (Phase 5); settings screen, Telegram, re-alert on further drop, item-group expansion, EU region filter (later).

## 4. Slices

Engineer-days for one engineer without agents, tests included; recalibrated from Phase 0 ([roadmap](../03-roadmap.md)). Each merge: CI green plus a fresh-context Claude Code review (D-37).

| # | Slice | Content | Days |
|---|---|---|---|
| S1 | Domain, test-first | GPU and RAM modules, `classify`, `segmentKey`, junk rules, item-group rejection, `landedCostCents`, `bandCheck`, `decideSlice1`, `countInstantLastHour`, `budget/*`, `Clock`; `buyerProfile.ts` (`vatClass` text-only, `priceBasis` gross, `checklistLines`), `vatPhrases.v1.ts` | 5.5 to 8 |
| S2 | Schema, retention, counter | Tables, purge every 15 min, `app.reserve_ebay_call` before every Browse call, `audit_event` with every edit | 3 to 4.5 |
| S3 | Sign-in | Better Auth `emailOTP({ otpLength: 6, expiresIn: 300, allowedAttempts: 3, storeOTP: "hashed", disableSignUp: true })`, limiter `storage: "database"`; caps in `sendLoginCode` (10 per user per hour, 40 per day); break-glass CLI; Lax cookies, no CORS | 2.5 to 3.5 |
| S4 | Feed engine, governor | `poll` (exclusive, key = feed), `cheap-sweep`, `quota-read`, breaker; per-item Zod; dedupe; overflow to 3 pages; candidate cap; enqueue in the transaction (`fromDrizzle`) | 4.5 to 6.5 |
| S5 | Enrich, decide, send | One full getItem; code scan (contact data, off-eBay payment, junk, look-alikes, VAT text); routing; COMPACT recheck before send and at 30 min; digest; templates | 5 to 7 |
| S6 | Dashboard | Watches with Feeds (cost against cap), Deals (what-if, feedback), Ops tables. D-50 labels: Real deal, bought; Real deal, not needed; Price not good enough; Wrong product; Scam or suspicious; Gone before I looked | 3.5 to 5.5 |
| S7 | Production readiness | Heartbeats `ebay`, `backup`, `host`, `ses-suppression`; ops mail; CLI; backup; drill; runbooks | 3 to 4 |
| S8 | Measurement | See rules | 2.5 to 3.5 |
| S9 | Go-live | About 10 calendar days | 2 to 3 |
| S10 | Gaming PC (D-56) | Phase 2 if under ~5 listings a day or S1 to S9 overrun | 1 to 1.5, extra |
| S11 | Before day 14 | Watch preview, Ops charts, saved-search import CLI | 2.5 to 3.5, extra |

Order: S1/S2 (S3 beside), S4, S5, S6/S7/S8, S9; path 18 to 27 days. Parallel agents stay file-disjoint; one schema change at a time.

**Rules:**

- **Data:** `watch.buyer_profile` not null default `company`; `listing` holds VAT columns and `seller_account_type`; `seen_item` no prices; `alert` holds `in_band_at_decision`, `available_at_30m`, `buyer_profile`, `vat_class`, `price_basis`. Payloads `{ listingId }` only. No seller username or ID column; timestamptz only.
- **Retention:** content and title sample deleted 6 h after fetch; `listing` rows only for candidates, deleted at `gone_at` (ended, not found, end date passed, or 48 h unconfirmed); price columns NULL at 30 days; item queues `deleteAfterSeconds: 3600`, `retentionSeconds: 21600`.
- **Candidate once:** `UPDATE seen_item SET candidate_at = now() WHERE item_key = $1 AND candidate_at IS NULL RETURNING`, same transaction as the `listing` row and enrich job.
- **Cheap sweep:** `sort=price`, 200 items, hourly around the clock; finds price drops into a band. A new item under 2 h old counts as a poll miss; a full in-band page sets `sweep_truncated` and mails ops (split the feed).
- **Query:** `deliveryCountry:DE,itemLocationCountry:DE,price:[<floor>..<ceiling>],priceCurrency:EUR,buyingOptions:{FIXED_PRICE|BEST_OFFER}`, ENDUSERCTX encoded; ceiling = highest maximum in the feed, floor suggested at 40% of the lowest.
- **Budget (Browse limit 5,000 a day):** a 2/10 feed costs 528 polls + 24 sweeps = 552 (5/10: 264). Shared: quota reads 96, overflow 30 per feed, on-demand 200, contract 50. A candidate costs at most 3 calls; 20 candidates per watch per day, then `budget_skipped` and one ops mail; polls never shed. Five 2/10 feeds leave 744 calls = 248 candidates = at most 12 watches. Shed in ADR 0016 order, mail at 90%; breaker after 5 failures, half-open after 15 min.
- **Routing:** item group, wrong segment, junk or above maximum: none. Shipping unknown, below floor, red flag: digest. Else instant if the setting is on and fewer than 3 this hour.
- **Checklist:** company: business account, no withdrawal right, conditional § 377 HGB line, three Käuferschutz deadlines, keep the invoice. Private: private account, both seller cases as "if" lines. Simon approves wording.
- **S7:** `ops:switch`, `ops:set`, `ops:audit`, audited. Nightly dump by host timer: no `ebay_live` or jobs, age-encrypted, at most 17 days (ADR 0025). `/opt/traefik/dynamic/ebay-sniper.yml` adds `/app` and `/api`. Verify X-Forwarded-For behind Traefik before relying on empty `trustedProxies`.
- **S8:** delay `first_seen_at - item_creation_at` (poll-found, relists apart); drop bound day/night; 20 rejected titles per feed per hour for 48 h; `scripts/review-metrics.sql` on non-price columns; snapshots days 14, 21, 28; two saved searches from day 1. Review thresholds (proposals until D-08): at least 2 purchases, 70% lead over saved searches, 50% available at 30 min, at most 5 unwanted alerts a day, at most 10% missed; unwanted (M4) = Price not good enough, Wrong product, Scam or suspicious.
- **S9:** re-read the licence footer date. Day 1 one feed; days 2 and 3 all feeds, digest only (AC-29); days 4 to 10 the 7-day run, with one restart and one deploy plus rollback on Simon's go. Growth Check only if the pool is tight, by Simon's decision (D-57).
- **S11 preview:** one search, `limit` 50, in memory, no aggregates, 40 calls per user per window, 10 s timeout.

## 5. Acceptance criteria

Integration = Vitest on Postgres 18; production = evidence in the exit note. AC-01 to AC-29 required; AC-30 due before day 14.

| ID | Criterion (check) |
|---|---|
| AC-01 to 03 | Code expires at 300 s; 4th wrong attempt fails; code stored hashed; unknown address: no mail, same response, no user row |
| AC-04a/b | 4th request per IP refused, limiter survives restart, multi-entry XFF not trusted; 11 requests for one user send 10 (11th logs `login_code_capped`); 41st per day refused |
| AC-05 | Golden titles map to key or rejection; item groups rejected |
| AC-06 | `decideSlice1` returns one deterministic route; a lower in-band price never gives "none"; rate count boundary at 60 min (fast-check) |
| AC-06b | Default `company`; `alert` needs `buyer_profile` and `price_basis`; profile changes text and flags only, never the route; `vatClass` golden cases ("keine MwSt. ausweisbar" is no invoice); what-if writes and calls nothing |
| AC-07 | Budget gives 552/264, 744 calls, 248 candidates; 13 watches refused, 12 accepted |
| AC-07b | 500 in-band items for one watch: at most 20 enrichments, 60 calls, 480 skipped, one mail; accepted plans stay under 80% (property) |
| AC-08 | 250 items in 2 pages; one malformed counted, 249 processed; third all-new page sets `cap_reached` (MSW) |
| AC-09/10 | Polls of one feed never overlap; one item in two feeds: one `seen_item`, at most one `listing` |
| AC-11 | Crash before commit: no alert, no job; after SES accepted: at most one duplicate; duplicate key refused |
| AC-12 | Recheck finding ended, gone or above max stops the send with a reason; lower price sent |
| AC-13 | 5 in-band listings in an hour: 3 instant, 2 digest; setting off: 5 digest |
| AC-14 | Emails carry the fields of section 1, a plain-text part, no seller username; sender on `alerts.intra-ai.de`; `<script>` titles escaped |
| AC-15/16 | Content gone within 6 h 15 min, `listing` within 15 min of `gone_at`, prices NULL at 30 days; sentinel ID and title never in jobs, backups or logs |
| AC-17 | Polling switch off stops all Browse calls from the next tick; every Browse call has a reservation |
| AC-18 | 2 × 1,000 concurrent reservations record exactly 2,000, none past the limit; alert-path floor never shed while `remaining > 0` |
| AC-19/20 | 5 failed polls open the breaker and mail ops; email switch off holds deliveries, sends them when back on |
| AC-21 | Edits write `audit_event` in the same transaction; feedback only by authenticated POST |
| AC-22 | Production: 7 days all feeds at or under 80% of the `getRateLimits` limit; cap hits explained; one alert opened on eBay |
| AC-23 | Production: delay p50/p95 per feed, drop bound, supply, poll misses on Ops |
| AC-24 | Production: restart and deploy + rollback with a 5 s check from outside the server; longest gap under 2 min; UptimeRobot keyword probe on `DELETION_PROBE_CODE` every 5 min (ADR 0030) green all run |
| AC-25 | Backup restored with empty `ebay_live` and `pgboss.job` within the 4 h RTO |
| AC-26 | Saved searches ran from day 1, emails kept; SQL returns M1 to M4 |
| AC-27 | An item seen above max, then swept in band, becomes a candidate once (`source_path = sweep`); repeats create nothing; works at 03:00 across CEST to CET |
| AC-28 | Snapshots hold counts and shares; M1 to M5 unchanged after price null-out |
| AC-29 | Production: Simon reviews rejections at about hour 12 and 36, records counts; each miss becomes a retyped synthetic golden title before instant alerts |
| AC-30 | S11: preview has no aggregate field; 41st call refused; Playwright covers it; Ops charts; import CLI gives M5 |

## 6. Test strategy

- **Test-first (`packages/domain`):** synthetic golden titles (keys set by Simon), routing, budget properties, sweep rule, code scan, buyer profile, CEST to CET on 25 Oct 2026.
- **Integration:** queues, crash replay, constraints, counter, retention, sentinels, Better Auth, eBay client on MSW.
- **Contract (manual):** Simon over SSH, one-off container, purpose `contract` (50 a day), after query changes and before go-live: no `warnings`, EUR, shipping, OR lists, getItem parse, `ended`/`not_found` mapping, whether `getRateLimits` counts.
- **Playwright:** login, create watch, feedback. Locally only changed tests; CI runs the rest.

## 7. Risks

| Risk | Mitigation |
|---|---|
| eBay revokes the keyset or suspends accounts | Call limits kept, minimal retention, no resale; kill switches stop polling without a deploy |
| Shared host overloaded: late polls, skewed delays | Memory limits, `ebay` and `host` heartbeats, log rotation |
| Unscreened alert leads to a scam purchase | Below floor and red flags to digest; 48 h digest only; checklist; eBay checkout |
| Stale bands, thin supply, classifier misses, late drops | M4, watch review every 2 weeks; supply counts; 48 h review, poll misses, saved searches; hourly sweep |
| SES access slow | Sandbox: verified recipients only, 200 mails per 24 h, 1 per s; enough for Simon's verified address |
| Deletion endpoint down after deploy | Check script, probe, rollback on failed `/healthz` |
| No second human reviewer | CI, fresh-context review, Simon reads high-risk diffs |
| Estimate overrun | S10 moves first; S11 outside exit; then Ops as SQL views |

## 8. Exit gate

Agents draft `phase-1-exit.md`; Simon signs.

1. AC-01 to AC-29 met with evidence; CI green on `main` for the commit that ran the 7 days (run URL).
2. Runbooks merged; Simon ran the kill-switch runbook once in production.
3. Section 2 ADR amendments made; ADRs due before exit Accepted.
4. Review date set from the first sent alert; not after day 29 without the day-28 snapshot.
5. Recorded: calls per feed, candidates, skips, alerts a day, delays, supply, share available at 30 min, days per slice.
6. Due dates for AC-30, S11, S10.

## 9. Estimate

Planned 31.5 to 45.5 days; with 30% contingency **41 to 59 engineer-days**, plus about 2 weeks for S9: **10 to 14 calendar weeks** (without agents, owner time excluded). External waits: SES production access ("within 96 hours"), the 10-day run, the first nightly dump.

## Sources

Read 2026-10-19: developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html, developer.ebay.com/develop/api/buy/api_call_limits, developer.ebay.com/join/api-license-agreement/ (footer "Sept 3, 2025"), www.better-auth.com/docs/plugins/email-otp, docs.aws.amazon.com/ses/latest/dg/request-production-access.html, pgboss.io/api/adapters (all https). Unverified: getItem error codes, `getRateLimits` fields, all starting values.
