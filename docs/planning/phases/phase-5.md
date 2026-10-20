# Phase 5: calibrate and extend

Status: proposed, 2026-10-19. Owner: Simon Klimaszyk (D-01). Estimates are for one person with Claude Code, unmeasured, recalibrated after Phase 0.

## 1. Goal

Replace the starting decision config with values checked against our own labels (**5A**), and make adding a hardware sector routine (**5B**).

If a review cut the product back to max-price alerts (D-07), 5A calibrates watch maxima instead of tiers.

## 2. Ground rules

- **Licence:** anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use.
- **Always kept:** call limits and budget (ADR 0016), minimal retention of listing content, no seller identifiers to Claude, no resale, no eBay content in git or eval cases, gate 3 (ADR 0002).
- **Calibration limits:** tighten-only from stored data (D-28); at most two thresholds and one band boundary per round; at most one round a month (D-54). Loosening and method changes are tested forward (5A.8).
- **Review (D-37):** CI green before merge (enforced by the `main` ruleset) and a fresh-context Claude Code review by convention; Simon's go before each production deploy.

## 3. Entry criteria

- Phase 3 exit passed; 30+ labelled instant alerts per sector on the current config inside the window
- Version columns and the stored tier inputs (`landed_cents`, `risk_premium_bp`, `buyer_profile`, z, points, tier) on `decision` (ADR 0009)
- 5A.0 live 14+ days before 5A.7 and 4 weeks before the Telegram question is read, since its columns collect data only from then
- Eval harness with held-out split and `evals/held-out` status (ADR 0026)
- `first_seen_at`, `item_creation_at` kept 14+ days; `alert.available_at_30m` recorded; budget functions give 552 calls/day per 2/10 feed and 264 per 5/10 feed (ADR 0016)
- D-08 extended: precision target (proposed 0.60), minimum 30 instant alerts in 28 days; D-11, D-50, D-51, D-52, D-54 decided ([decisions](../02-decisions.md))
- ADRs accepted: 0004, 0009, 0014, 0016, 0017, 0019, 0023, 0024, 0026, 0028 before 5A; 0010, 0011, 0015, 0018 before 5B ([ADR index](../../adr/README.md))

**Window.** While the 30-day nulling of price columns stays (D-11, ADR 0014), the backtest window is 28 days. If Simon drops it, the window follows `decision` retention (180 days) and 5A.2b is not needed.

**Labels (D-50):** "Real deal, bought", "Real deal, not needed", "Price not good enough", "Wrong product", "Scam or suspicious", "Gone before I looked". Precision = real-deal labels / all but "Gone". False alert = the three negative labels. Instant alerts labelled within 7 days; shadow and blocked items within 6 hours (D-34).

## 4. Scope

**In:** the slices below and ADR 0033 (calibration process). Only if needed: ADR 0034 (fair-value method v2); records superseding ADR 0016 default schedules or the `SectorModule` interface of ADR 0010; a record defining `prompt_version` per sector composition, before pilot step 5; the computed auction ceiling, after calibration backtest 5A.3, with its own ADR ([phase 4 Appendix A](phase-4.md)).

**Out:** new marketplaces; pooled segments (ADR 0010's own trigger); loosening from stored data; automated tuning or ML on stored alerts; whole-PC valuation; outside reverse-image search; a dashboard sector editor; bidding or buying.

## 5. Slices

### 5.1 Part 5A: calibration

| # | Slice | Days |
|---|---|---|
| 5A.0 | **Expand-only migration, first.** One migration adds what Phases 1 to 3 lack, all nullable or with defaults: `alert.first_viewed_at` (set only by the authenticated deal-page POST), `alert.available_at_2h` and `_6h`, D-50 labels, `review_label.pattern_category` and `pattern_note`, `feed.trial`, and `alert.kind = 'trial'`, which keeps trial hits off a later instant alert's unique key. It adds `method_version` to the `fair_value` key if missing. | 1 to 1.5 |
| 5A.1 | **Readiness view** on Ops: labels per segment and config version, backlog, rows nulled or due in 7 days. | 1 to 1.5 |
| 5A.2 | **Backtest, test-first.** `backtest(records, base, candidate)` in `packages/domain` recomputes stored tiers under both configs, each row under its stored `buyer_profile`, and returns kept, removed and changed alerts per tier and label with Wilson intervals (confidence intervals for a proportion). A replay check runs first; if the stored config misses any tier, the run lists the row IDs and exits non-zero. Nulled rows count as "outside the window". Candidates are merged inactive and activated by a second PR. | 3 to 4 |
| 5A.2b | **Candidate tiers (conditional):** if under 30 labelled rows in the window, store `decision.candidate_tiers` for up to two pre-registered candidates. | 1 to 1.5 |
| 5A.3 | **First round.** Test up to two thresholds and one band boundary (the seller-type premium may be one). **Adoption rule (ADR 0033, fixed before the run):** among removed alerts, bad = "Price not good enough", good = real-deal labels. Adopt only if 5+ bad are removed, the Wilson 95% lower bound of bad/(bad+good) exceeds 0.5 and no "Real deal, bought" is removed (5/5: 0.57, adopt; 7/8: 0.53, adopt; 8/10: 0.49, reject). There is no override; only a new ADR changes the rule. The "Gone" share is outside the rule, reported every round, and feeds 5A.7 and the review. | 2 to 3 |
| 5A.4 | **Ask-to-sold ratio refresh:** monthly reminder when missing or over 30 days old (valid: 10+ sales, ratio 1 to 1.5). No valid ratio, no No-brainer. | 1 to 1.5 |
| 5A.5 | **Eval growth and model-change runbook.** Pattern fields, and the switch that drops "not yet validated" at 40 scam (3+ per category) and 40 legitimate held-out cases with the last gate green. A new scam category in the ADR 0026 list needs a new ADR. Runbook (5.5 models retire late Sept 2027 at the earliest, 60 days' notice): candidate eval, 1 to 2 weeks of live shadow, verdict rates per feed, recalibrate, switch via config. | 2 to 3 |
| 5A.6 | **Shadow step-down and second review.** After 4 to 6 weeks, about 1 deep evaluation a day. Review sheet: D-08 metrics, precision with Wilson interval, time to alert p50/p95, recall against saved-search emails. Decision logged in ADR 0004. | 1 |
| 5A.7 | **Poll interval.** `intervalImpact(delays, survival, schedule)` gives extra delay and calls/day for 2/10, 5/10 and 10/30. Inputs: indexing delay (p50/p95, 14+ days) from `item_creation_at`, not the relist-surviving `itemOriginDate` ([Browse OpenAPI](https://developer.ebay.com/develop/api/spec/browse_api.json)); deal lifetime as a right-censored survival curve over all deal-tier candidates; price-drop delay; the blind spot. Rechecks at 2 h and 6 h (up to 20 candidates a day, 14 days) cost at most 40 calls a day from the alert-path remainder; the budget check must still pass. **Rule:** the longest interval whose extra delay is under 10% of the lower lifetime quartile, set per feed. | 2 to 2.5 |
| 5A.8 | **Forward trials (conditional).** (a) Trial band: a looser bar's extra hits go to the digest as `trial`, charged to the shadow lane so they pause first under the budget guard. After 2 weeks the loosening is adopted if 5+ extra hits are labelled real-deal and the Wilson lower bound of good/(good+bad) exceeds 0.5. (b) Method v2 in parallel, only once ADR 0034 is Proposed with its criterion. | 2.5 to 3.5 |

**Order:** 5A.0 first, then 5A.1, 5A.2 and 5A.3; 5A.5 and 5A.7 run beside 5A.2 (file-disjoint). 5A.2b is built before the window starts; 5A.8 on demand.

**Field scam to eval case:** within 6 hours Simon notes the scam in his own words (max 280 characters; a note sharing any 8-word run with the listing is rejected). Monthly he rebuilds notes as synthetic cases, checked by a fresh-context agent against the ADR 0026 authoring rule.

### 5.2 Part 5B: add-sector procedure

| Step | What | Effort |
|---|---|---|
| 0 | One-page proposal; Simon decides | 1 h |
| 1 | EBAY_DE categories and aspects via the Taxonomy API; contract test asserts leaf IDs and aspect names | 0.5 d |
| 2 | Supply count: one query an hour for 7 days (168 contract calls), counts only; check one 200-item page covers a poll interval at peak | 0.5 d + 7 days |
| 3 | Budget: a 5/10 feed uses 264 calls/day, plus up to 20 refresh, 30 overflow and 60 per watch. Five 2/10 feeds leave room for 12 watches, a sixth 5/10 feed for 7; moving the five to 5/10 frees 1,440. One 5,000/day Browse pool ([call limits](https://developer.ebay.com/develop/api/buy/api_call_limits)); the editor refuses plans above 80%. Beyond: merge feeds, 10/30, Growth Check | 0.5 h |
| 4 | Module test-first: segment-key goldens (CPU: 7800X3D vs 7800X, tray, mobile), German and English junk rules, valuation config, fraud signals, prompt fragment under cap, arrival checklist; passes the conformance suite | 2 to 3 d |
| 5 | 10+ eval cases with Intra AI photos; `prompt_version` changes only for this sector | Simon + 0.5 d |
| 6 | Products, watches (maximum from outside eBay, `buyer_profile` default `company`, D-04), `trial` feed in the dashboard | 1 h |
| 7 | 14 days rules-only digest (pass rates, calls vs step 3, wrong-product rate), then 7+ days with Claude screening (stage pass rates, spend, verdict rates) | 3 weeks |
| 8 | Promotion on Simon's go if wrong-product rate is under 10%; tiers per segment when the effective sample size (neff) is 8+ on most nights, No-brainer only with a valid ratio; `docs/sectors/<sector>.md` | 0.5 d |

**Pilot (D-52):** desktop CPUs, one 5/10 feed. SSDs second; monitors hardest.

**Slices:** 5B.1 runbook, supply-count job, conformance suite and trial mode (2.5 to 4 days); 5B.2 the pilot end to end by a fresh-context agent reading only the runbook, gaps fixed in the same PR (4 to 7 days).

### 5.3 Optional extras (only at their D-51 threshold)

| # | Extra | Entry | Days |
|---|---|---|---|
| 5B.3 | Telegram mirror: product, tier, dashboard link; no eBay title or images, and no landed price by default (eBay-derived); purged after 6 hours | 30%+ of alerts first viewed after 30 min, 4 weeks, 30+ alerts | 2 to 3 |
| 5B.5 | Duplicate photos: perceptual hash in `ebay_live`, deleted with the listing | 3+ missed stolen-photo scams a month | 3 to 4 |
| 5B.6 | Market-check experiment (ADR 0019) | a written question and the decision it changes | 3 to 4 |
| 5B.7 | Gaming-PC component info line | Simon asks | 1 to 1.5 |

## 6. Acceptance criteria

Waivers only for the stated reason, with the number and Simon's sign-off in the exit record.

| ID | Criterion | Test |
|---|---|---|
| AC-1 | Replay reproduces 100% of v1 tiers or exits non-zero with mismatches | Planted-mismatch fixture |
| AC-2 | Identical candidate: zero changes; tighter: never adds an alert; each row replayed under its stored `buyer_profile` | Property tests (fast-check 4.x); replay test with `company` and `private` rows |
| AC-3 | CLI output has no title, item ID or key, price or ratio | Sentinel test |
| AC-4 | Nulled rows skipped and counted; under 30 replayed → sector skipped | Postgres test, injected clock |
| AC-5 (waivable: under 30 alerts everywhere) | Record: at most two thresholds and one boundary, label and removed counts, rule result, approver, no prices or ratios; v2 deployed and on later decisions | Record review against ADR 0033 fields; SQL |
| AC-6 (waivable: under 14 days of delay data) | Per feed: schedule, rule outcome, censoring figures and predicted calls recorded; a week later calls within 10% and under 80% | Record review; `api_usage_hourly` |
| AC-7 | `intervalImpact` monotone; all-censored data gives no recommendation | Property test |
| AC-8 | No valid ratio, never No-brainer | Property test |
| AC-9 (case count waivable) | A held-out regression turns `evals/held-out` red; validated switch only at 40 + 40 | Planted-regression PR; switch test |
| AC-10 (waivable: backlog reported with Simon's labelling time for the next 4 weeks) | Shadow about 1 a day; 80%+ labelled in time | Ops query |
| AC-11 | Second review held, every D-08 metric shown, decision logged | Review record |
| AC-12 | Pilot via runbook only, conformance passed, 14 days rules-only, calls within 10%; outcome (promoted, or stopped with the reason) in `docs/sectors/<sector>.md` | CI; sector record |
| AC-13 | 5B.2 has no migration; all migrations expand-only | Diff check |
| AC-14 | Each extra flagged off or dropped, with its number | Config test |
| AC-15 | Retention sentinels cover every new column and channel | Sentinel suite |
| AC-16 | Registers list every new processor and secret | Checklist |
| AC-17 | CLI runs from the production image with `node` only | CI image smoke test, Postgres 18 |
| AC-18 | A sector fragment changes `prompt_version` only for that sector | Unit test, two sectors |

## 7. Test strategy

- **Unit, test-first:** Wilson values (24/30: 0.627 to 0.905); adoption examples; `intervalImpact` goldens (552, 264); conformance suite. **Integration (Postgres 18):** window loader, version stamping, POST-only `first_viewed_at`, note copy check, trial key clash.
- **Local:** touched tests, typecheck and lint only; full suites and AC-17 in CI; contract runs manual. No push spends eBay or Anthropic budget.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Too few labels in the window | 30 minimum, readiness view, 5A.2b, skip and record, or drop nulling (D-11). Running weekly does not preserve prices |
| One person labels and approves | Rule fixed in ADR 0033, no override; fresh-context review |
| Label bias (only alerted items get labels); overfitting | Tighten-only, round limits, minimum count, Wilson bound, forward trials |
| Tightening hides a speed problem | "Gone" share reported every round (5A.3), used by 5A.7 |
| Price-derived output leaks into git | Allowed record fields in ADR 0033; AC-3 |
| New sectors exhaust the pool or misclassify | 5/10 default, 80% cap, interval decision first; goldens, 14 days rules-only, 10% gate |
| Shared host overloaded | Short jobs; check disk before new feeds |
| Bad config | Revert and deploy; emergency tightening (D-54) |

## 9. Exit gate

1. All criteria hold or are waived as allowed; ADR 0033 accepted.
2. Precision on 30+ labelled instant alerts in 28 days, with Wilson interval, at or above the D-08 target; alert count, availability and false alerts within target (precision by sending almost nothing fails).
3. Pilot promoted or stopped with a reason; CLI checked from the production image on production data.

## 10. Estimate

Core: 5A (5A.0 to 5A.7) 13 to 18 days, 5B 6.5 to 11, integration (about 15%) 3 to 4.5; **total 23 to 34**. Conditional: 5A.2b 1 to 1.5, 5A.8 2.5 to 3.5, all extras 9 to 12.5.

Waits: 4 weeks of labels plus up to 7 days of labelling delay; 14 days of rechecks; pilot 3 to 4 weeks. Simon: 1 to 2 days per 10 eval cases, 5 to 10 minutes a day labelling. First round about 5 to 6 weeks in; close at 8 to 10 weeks. Each extra deep evaluation a day costs $2.20 to $5.60 a month on Sonnet 5.5.
