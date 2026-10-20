# ADR-0004: Product modes, slice order and the 28-day review

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0002, 0006, 0015-0019, 0022, 0032, 0033; D-04, D-05/D-06, D-07, D-08, D-09, D-36, D-44; [roadmap](../planning/03-roadmap.md), [phase 1](../planning/phases/phase-1.md), [phase 2](../planning/phases/phase-2.md)

## Context

- Anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use.
- The earlier plan's first email came months in, with no metrics or stop point.
- eBay.de saved-search emails are free, with no published delay (https://www.ebay.de/help/buying/search-tips/saved-searches?id=4051); the tool has to beat them.

## Decision

Ship **max-price alerts (F1)**, then **fair value and tiers** (layer A) and **Claude screening** (layer B), each behind a code constant. Slices 1 to 3 each run in production before the next; 4 and 5 may overlap. 28 days after the first production alert, Simon decides continue, cut or stop.

## Product modes

| Mode | What it does | On by |
|---|---|---|
| F1 | Watch band in EUR (floor, maximum), `buyer_profile` (D-04); landed price (item plus shipping) checked against the band; classifier, junk words, contact and payment-phrase scan | Gate 1a |
| A | Fair value and tiers (ADR 0017), shown after the review snapshot | `fairValue` PR (Phase 2) |
| B | Triage, deep evaluation, verdict (ADR 0019) | `CLAUDE_SCREENING_APPROVED`, ADR 0018 (Phase 3) |

**Feeds.** One shared leaf-category feed serves several watches. Feed ceiling = highest watch maximum, feed floor = lowest watch floor. The band is checked on landed price in code, as the Browse price filter's handling of shipping is unverified.

**Slice 1 alerts (D-09).** Default: hourly digest. With `alerts.instantUnscreened` on, in-band listings that pass the rules and a getItem recheck go instant, capped at 3 per watch per hour; overflow goes to the digest. Below floor, red flag or unknown shipping: digest only. One `band` alert per item (tier `none`, checkpoint `none`, ADR 0015) covers all matching watches; the cap uses the matching watch with the lowest maximum, no re-alert on a price drop.

## Slice order

1. **F1 email alerts** (Phase 1): feeds and call budget (ADR 0016), rules, recheck, SES (ADR 0022), D-24 screens on `https://deals.intra-ai.de`, no Settings screen (settings CLI, phase-1.md). Done after 7 days of production alerts, at least one alert sent, delay and supply counts recorded.
2. **Fair value and tiers** (Phase 2), starting at Phase 1 go-live.
3. **Claude screening** (Phase 3).
4. **Auctions with the watch maximum** (Phase 4, ADR 0032): `effectiveMaxBid` from the watch; instant T-60 alerts only on a D-44 go.
5. **Calibration** (Phase 5, ADR 0033), beside slice 4 once there are 4 weeks of labels.

After slice 5: a computed bid ceiling (needs layer A and the first calibration round, D-36), the market check as an experiment (D-23), Telegram last.

## 28-day review (D-07; numbers proposed, D-08 open)

| Metric | Met | Near | Missed |
|---|---|---|---|
| M1 purchases via a tool alert, at or under the maximum | 2+ | 1 | 0 |
| M2 items in both where the tool alerted first | 70%+ | 50-70% | <50% |
| M3 alerts still live at the 30-minute recheck | 50%+ | 25-50% | <25% |
| M4 unwanted alerts per day | 5 or fewer | up to 7.5 | >7.5 |
| M5 in-band items only in eBay's emails | 10% or less | up to 15% | >15% |

M4 counts feedback "Price not good enough", "Wrong product" and "Scam or suspicious" (D-50), daily average across recipients. Near means within half of the target; M2 near starts at 50%. M2 needs 20 shared items to be computable. First match decides:

| # | Condition | Outcome |
|---|---|---|
| 1 | Under 10 alerts or M2 not computable, no extension used | Extend once by 28 days |
| 2 | M1 or M2 missed | Stop: use eBay's saved searches by hand |
| 3 | M1 or M2 near, M2 still not computable, or any of M3 to M5 missed | Cut: keep slice 1, build no more |
| 4 | Otherwise | Continue |

Simon holds the review alone and records it in docs/adr with hours spent against the estimate. M2: 2 saved searches on the Intra AI business account, forwarded and checked every Monday; `scripts/match-saved-search.ts` matches by `item_key` and the email Date header; forwarding gaps over 3 days are excluded from M2 and noted.

## Alternatives considered

Plan's phase order (no feedback for months); no stop rule; computed auction ceiling before calibration (uncalibrated, unknown volume).

## Consequences

- Positive: first alert after Phase 1; later slices use measured data; a dated stop point.
- Negative: slice 1 alerts are unscreened; band then tier logic; M2 and bands are manual.
- Risks: a scam purchase (digest routing, eBay checkout only, arrival checklist; every email names the eBay-Käuferschutz deadlines: return request within 30 days of the shown delivery date, non-receipt report within 30 days after it, escalation to eBay within 30 days of reporting to the seller); too few purchases (extension); keyset revoked or accounts suspended.

## How we check it

- `packages/domain/src/licence-layers.ts`: flags start `false`; an activation PR flips one, merges after CI and review (D-37).
- `fairValue` false: no `fair_value` or `price_observation` rows. `claudeScreening` false: every email says "not reviewed by Claude".
- Property test: other listings never change `decideSlice1(listingFacts, watch, ruleResults, instantCountLastHour, setting)`.
- Every grade combination, "not computable" and "extension used" map to exactly one outcome.
- Reminders (D-48): ops email with the review date on the first `sent` delivery, again on that date, then every 3 days for 2 weeks; weekly `review-due` workflow fails if the date or note is missing. `scripts/review-metrics.sql` grades M1 to M5.

## Revisit when

- Review ends in cut or stop, or a metric is unmeasurable.
- Keyset revoked, account suspended, or saved-search emails change.
- Band upkeep over an hour a week, or colleagues join.
