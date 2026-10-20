# Phase 4: auctions with the watch maximum

Status: proposed, 2026-10-19. Owner: Simon Klimaszyk (D-01); his go precedes every production deploy. Record: [ADR 0032](../../adr/0032-auction-path.md). P4-1 to P4-4 are D-41 to D-44 in [decisions](../02-decisions.md).

The tool never bids (gate 3, [ADR 0002](../../adr/0002-human-completes-every-purchase.md)).

## 1. Goal

Surface used GPUs, RAM and gaming PCs sold as auctions on eBay.de while a person can still place a maximum bid. The limit is the watch maximum under the watch's `buyer_profile`. At exit:

1. An email about 60 min before the end, only when next valid bid plus shipping is under the limit and screening passed: "enter at most EUR X in eBay's automatic bidding".
2. A 21:00 digest of auctions ending 23:00 to 09:00, with limit and verdict, and an "Ending soon" filter on Deals (D-24).
3. Measured numbers so Simon can decide continue, digest-only or drop.

## 2. Ground rules

- **Licence:** anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use.
- **Kept:** call limits and budget, minimal retention, no seller or bidder identifiers stored or sent to Claude. The parser drops `reservePriceMet` and `itemAffiliateWebURL`.
- **Hosting:** a shared Docker host behind Traefik (`intra-ai`, `/opt/ebay-sniper`).

## 3. Entry criteria

- [Phase 3](phase-3.md) exit passed (ADR 0015, 0019), or F1 with "not reviewed by Claude".
- Phase 0 auction counts per product (D-20).
- D-34, D-36 (auctions after phase 3; ADR 0004 slice order edited, reason in ADR 0032) and D-41 to D-44 recorded, D-44 before S2a.
- ADR 0032 proposed in S0, accepted before S2a merges. Amendments: `auction-checkpoint` queue and `auction_bid` index (0015), sweep and "Auction checkpoints 200" lines (0016), revision hash (0031), metrics (0024).

| ID | Default |
|---|---|
| P4-1 | No "last call" email; T-15 sends only if T-60 did not; opt-in per watch |
| P4-2 | CAUTION: no instant email; red-flag box in "Ending soon"; hourly digest only if ending 45+ min later; overnight ones in the 21:00 digest |
| P4-3 | 200 calls a day for checkpoints and digest evaluations (about 66 auctions at 3 calls); reset after S1 week |
| P4-4 | Instant alerts only if at least 5 estimated alertable auctions a week in S1 (summary-qualifying, see S1, x phase 3 PASS share; 1 in F1); else digest-only |

## 4. Out of scope

Computed ceiling (phase 5, Appendix A); any bidding (no Offer API, browser automation or stored credentials); final-price prediction or recording; shill detection; first-sight triage; Telegram; non-EBAY_DE; auctions in the fair-value sample.

## 5. Slices

Reference engineer-days, one engineer without agents; unmeasured, recalibrated after Phase 0 ([roadmap](../03-roadmap.md)). Every slice ships behind the `auctions` kill switch.

| Time (Berlin) | Runs |
|---|---|
| 07:00 to 23:00 hourly, not 19:00 | Sweep [now, now+4 h] |
| 19:00 | Evening sweep [now, 09:00], up to 3 pages |
| 19:30 to 20:50 | Digest-route evaluations by headroom |
| 21:00 | Overnight digest |

An auction that ends inside the digest window (default 23:00 to 09:00) takes the **digest route** and gets no checkpoints; all others take the **instant route**. An auction first found after that night's digest is recorded as `missed_digest`, and nothing is sent. The 4 h window keeps T-150 ahead at first sighting. Settings refuse an instant T-60 inside quiet hours.

Why 19:00: it leaves up to 110 min for evaluations before 21:00 and keeps evidence under about 2 h old. The shortest eBay.de auction is believed to be 1 day (unverified), so overnight ones are listed by 19:00.

| Slice | Days |
|---|---|
| S0 ADR 0032, amendments, sweep shapes, contract assertions | 1.5 to 2 |
| S1 Discovery, checkpoints, measurement, recall reference; no email | 4.5 to 5.5 |
| S2a Evaluator, decision, bid limit, one-alert index, cap, email (on P4-4 go) | 4.5 to 6 |
| S2b Ending soon and feedback (on go; parallel worktree with S3) | 2 to 2.5 |
| S3 Overnight digest (no-go: plus 2 to 2.5 for S2a parts it needs) | 2 to 2.5 |
| S5 Ops metrics, runbook, sentinels, exit SQL in `docs/runbooks/` | 1 to 1.5 |

**S0.** The ADR 0016 shape builder starts from the feed's canonical filter and adds `sort=endingSoonest`, `limit=200`, `buyingOptions:{AUCTION}` and `itemEndDate:[start..end]` in UTC. The ceiling stays; the **floor is removed**, because `price` may act on the current bid and a floor would then hide real low-bid auctions. Evening pages use `offset` 0/200/400; a full third page alerts. The contract run on `intra-ai` checks AC 1 plus how `price` behaves, no duplicate pages, the COMPACT fields `minimumPriceToBid`, `bidCount`, `sellerItemRevision`, and what an ended auction returns. Fallbacks: 12034 drops the sort; missing fields cost one COMPACT per auction (in P4-3); missing `itemEndDate` re-plans before S2.

**S1.**
- Summary rules are segment, junk and item-group exclusion; `minimumPriceToBid` comes only from getItem, at checkpoints. An auction is **summary-qualifying** when the rules pass and, at the last sighting at least 60 min before the end (between E-120 and E-60 with hourly sweeps), `currentBidPrice` plus shipping is at or below the limit. The count overstates alerts: it is taken before screening (P4-4 applies the PASS share), and `currentBidPrice` is one increment below `minimumPriceToBid` (reported, not corrected). Measured per product per week: discovered, summary-qualifying, tracked, and dropped by the cap (reported separately).
- Each sighting writes content-free `seen_item` and `auction_sighting` (item_key, run, sighted_at, end_at, rule result, under-limit flag).
- `app.auction_checkpoint`, unique (item_key, checkpoint). One transaction: `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, pg-boss `send()` with absolute UTC `startAfter` via `db`, store job_id. `retentionSeconds` 86,400.
- If T-150 has passed and T-60 is at least 20 min ahead, a catch-up job runs T-150 at once.
- If the newest sighting is over the limit, no call is made. T-150 calls full getItem. T-60 calls COMPACT unless the auction is BLOCK or over the limit. T-15 follows P4-1. A changed revision re-reads the full item. On 11001 the auction is `ended_early` and its jobs are cancelled. On 11004 the handler retries once after 2 min. A job that starts after E-5 min records `missed_checkpoint`.
- Calls go under an `auction_checkpoint` line, capped by P4-3. At the cap, new auctions are refused with a reason code.
- Recall reference (Simon, about 1 h): saved auction searches for 2 watches, else a manual sample 3 evenings a week. `pnpm --filter worker auction-recall --from --to --file <ids.csv>` stores no raw IDs.

**S2a.**
- At T-150 or catch-up, if `minimumPriceToBid` is within the limit, claim and run the evaluator (revision hash = `sellerItemRevision` + description hash, bid excluded).
- `decideAuctionAlert` returns `send_instant`, `digest`, `review_only` or `none` with a reason, and records `buyer_profile`. Instant needs PASS and the instant route.
- `effectiveMaxBid(max, shipping, priceBasis, premiumBp, rateBp)` in `packages/domain/src/decide/buyerProfile.ts` ([company vs private](../guides/company-vs-private.md)): net `floor(max x (1+rate)/(1+premium))`, gross `floor(max/(1+premium))`, minus shipping, stepped to the largest bid passing `basis x (1+premium) <= max`. Premium from the risk config by profile, seller type, returns (ADR 0020, 0027). Net only under `company` with `vat_invoice_stated` and `inputTaxDeductible` (false until Simon confirms; not under § 19 UStG). Bid is gross.
- Partial unique index `alert (item_key) WHERE kind='auction_bid' AND checkpoint<>'last_call'`; digest entries use checkpoint `digest`. Cap 5 auction alerts per hour (assumption).
- Email: limit to the cent, profile, buying account, Berlin end time with zone, as-of, next bid, seller type, returns, verdict, VAT flags, checklist, plain `itemWebUrl`, binding note. Private: "14-day withdrawal right; for eBay auctions probably also, check before relying on it".

**S2b.** Reason codes (over cap, CAUTION, `missed_digest`, `missed_checkpoint`); content over 6 h old shows its age and Refresh. Feedback changes nothing until Confirm.

**S3.** After 19:00, one evaluation job per digest-route auction by headroom, from 19:30, within P4-3. The 21:00 cron builds the digest; an auction with no verdict by 20:55 is left out as `digest_unscreened` and triggers an ops email (D-48). One digest per (kind, window_start).

**S5.**
- Ops page: the S1 counts; checkpoint outcomes (ok, over_limit, ended_early, missed_checkpoint); `missed_digest` and `digest_unscreened` counts; calls against P4-3 with measured shares s150, s60, s15, s_rev; evening sweep pages and page-cap hits; lead time p50/p95; feedback counts; latest recall.
- Call estimate: calls a day = tracked a day x (s150 + s60 + s15 + s_rev) + digest-route a day.
- Runbook: kill switch, missed checkpoints after a deploy or outage, budget exhaustion, page-cap hit, weekly recall check.

## 6. Acceptance criteria

1. Contract: both shapes, no warnings, only AUCTION in window, three summary fields; 12034 or a missing field selects the fallback. (Manual.)
2. Shapes follow the feed's filter, no floor. (Unit.)
3. Ends 22:30, 23:30, 02:00, 08:59, 09:15: all found at 19:00; the middle three take the digest route and are in the digest, evaluated by 20:55; 22:30 gets T-150 at 20:00; 09:15 gets catch-up at 07:00 and T-60 at 08:15. 450 evening auctions use 3 pages; 650 alert. Repeated on 24/25 Oct 2026 (digest window 11 h, evening window 15 h) and 27/28 Mar 2027 (9 h, 13 h). (Integration.)
4. Checkpoints fall at E-150, E-60, E-15 in UTC; only future ones are scheduled, plus catch-up. (Property.)
5. Three sweeps give one row and job per checkpoint; a rollback after `send()` leaves neither; a 12 h delayed job survives. (Pinned pg-boss 12.x, Postgres 18.)
6. 11001 cancels the jobs and sends nothing; 11004 is retried once. (MSW.)
7. A job starting after E-5 min records `missed_checkpoint` and sends nothing.
8. Uses `minimumPriceToBid`, shipping once. Golden: both profiles, seller with and without returns, EUR 0 shipping, bid at limit alerts. Max EUR 500.00, shipping EUR 6.99, VAT 19%: net 5% EUR 559.68, net 0% EUR 588.01, gross 5% EUR 469.20, gross 0% EUR 493.01; band passes at limit, fails one cent above.
9. A higher `minimumPriceToBid` never turns `none` into `send_instant`. (fast-check.)
10. Without opt-in, an auction gets at most one `auction_bid` alert. A digest auction found again gets none. A crash after SES accepts gives at most one duplicate.
11. Two concurrent T-150 jobs make one evaluator call. A new revision makes a claim; a new bid does not.
12. BLOCK and failures never email. CAUTION follows P4-2. F1 emails say "not reviewed by Claude".
13. The digest stays unique across a restart at 20:59 to 21:01. Unscreened ones are counted and trigger the ops email.
14. All auction calls are counted; an over-limit sighting makes none; at the cap, new auctions are refused and tracked ones kept. S1 week daily calls stay at or below 80% of the pool.
15. Dropped fields and usernames never reach Postgres, payloads, logs or dumps; ended rows are purged (ADR 0014). (Dump sentinel.)
16. Email and digest content per S2a; the withdrawal line only under `private`; no description text in the subject. (Snapshot per profile.)
17. **Exit: 0 unexplained misses.** Every auction that met alert conditions, or is in the reference and summary-qualifying, has a delivery before E-15, a digest entry, or one explanation (kill switch, cap, ended early, BLOCK or failure, CAUTION, bid over limit). `missed_checkpoint`, `missed_digest`, `digest_unscreened` and never sighted are unexplained. (Committed SQL.)
18. **Exit: recall** at least 90% of at least 20 reference auctions sighted before E-60, Wilson interval reported.

## 7. Test strategy

- Test-first domain functions from S0 to S2a, including `summaryQualifying`, with an injected clock across both clock changes.
- Synthetic fixtures from the pinned Browse schema (ADR 0023), no recordings. Integration on Postgres 18; handlers take the clock, so only AC 5 waits on pg-boss.
- Contract job on `intra-ai`, never on push. About 5 auction eval cases (Simon owns, D-29).
- Runtime check per slice after Simon's go, low cap: S1 one auction through all checkpoints; S2a one email; S2b reason code and "Bid placed"; S3 one 21:00 digest.

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Bid limit above the watch maximum | High | Band-check stepping, AC 8 |
| Deploy or outage at a checkpoint loses an alert | Med | T-15 backup, AC 17, check "Ending soon" before evening deploys |
| Loaded host delays checkpoints or evaluations | Med | Late-job rule, `digest_unscreened` email, lead time p95 |
| Sweeps miss auctions silently | Med | Recall reference, AC 18, page-cap alert |
| Too few auctions under a sensible limit | Med | S1 week, P4-4, digest-only exit |
| Checkpoint calls starve fixed-price rechecks | Med | P4-3 cap, skip over-limit, refuse new first |
| Alert too slow for T-60 | Med | Lead time measured; offsets are config |
| Agent-written code merged with a defect | Med | CI, fresh-context review, test-first, runtime checks |
| Auction fever | Med | One number, binding note, win feedback |
| `price` acts on the current bid; sweeps fill with EUR 1 auctions | Low | Short window, ceiling, rules; a floor can return per feed |
| Duplicate or orphan jobs from rediscovery | Low | One transaction, stored job_id, AC 5 |
| Seller ends early or revises | Low | 11001/11004 rules, full re-read |
| Withdrawal rights (private, § 312g Abs. 2 Nr. 10 BGB) | Low | "Probably" wording; Simon checks before S2a |

## 9. Exit gate

1. AC 1 to 16 green in CI and the latest contract run; every merge reviewed fresh-context.
2. ADR 0032 and amendments accepted; the README states that the tool never bids.
3. Live period until 10 auctions met the conditions or 3 weeks, reference covering it; AC 17 and 18 hold; S5 figures reported per product.
4. Daily calls at or below 80% of the pool every day.
5. Simon records continue, digest-only or drop; default digest-only if under 10 qualifying or under 20 reference auctions.
6. Runbook, Ops metrics and production sentinels live.

If AC 17 or 18 fails, fix and restart the live period for at least one week.

## 10. Estimate

| Path | Days | Plus 25% | Weeks |
|---|---|---|---|
| Digest-only (S0, S1, reduced S3, S5) | 11 to 14 | 14 to 17.5 | 3 to 3.5 |
| Full (all slices) | 15.5 to 20 | 19.5 to 25 | 4 to 5 |

Fixed calendar: S1 week (S2a overlaps) and a 2 to 3 week live period, so at least 3 to 4 weeks after S1 ships. S2a is most likely to overrun.

## Appendix A. Computed ceiling (phase 5)

After calibration backtest 5A.3, D-21, D-25 and a measured ask-to-sold ratio (D-22). A segment without a measured ratio gets no ceiling.

```
max_landed  = good_bar x reference / ask_to_sold_ratio
ceiling_bid = floor(max_landed / (1 + premium) - shipping)
limit       = min(S2a bid limit, ceiling_bid)
```

Example: EUR 1,160, ratio 1.10, bar 0.92, shipping EUR 20 give 970.18, ceiling EUR 950 (returns) or EUR 903 (no returns, 5%). Gross basis. 2 to 3 days plus 25%, in phase 5.
