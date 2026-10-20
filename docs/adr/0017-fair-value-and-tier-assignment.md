# ADR-0017: Fair value method and tier assignment

**Date**: 2026-10-19
**Status**: proposed (waits on D-21, D-22, D-25)
**Related**: ADR 0004, 0009, 0010, 0013-0016, 0027; D-04, D-08, D-28, D-37, D-40, D-47; [company vs private](../planning/guides/company-vs-private.md)

## Context

- No API gives sold prices, so fair value uses active asks, which sit above sold prices by an unmeasured gap.
- The plan's reference (bootstrap lower bound of the median) is the minimum at n = 8 and the 10th value at n = 30, so it tracks supply.
- Feed polls carry a price ceiling and include auctions, so they are not the sample.
- Browse ([OpenAPI v1.20.4](https://developer.ebay.com/api-docs/master/buy/browse/openapi/3/buy_browse_v1_oas3.json), read 2026-10-19) keeps `itemOriginDate` across relists, has no price-change date and caps `limit` at 200.

## Decision

`fv-1` is a weighted median per segment over one complete, unfiltered nightly sweep of fixed-price asks, divided by an ask-to-sold ratio when one exists.

0.6, 3.5 and the step order are method constants (`FAIR_VALUE_METHOD_VERSION`, `domain/src/pricing/`): changing them is a new method version. Thresholds (bars, z guards, neff and half-width gates, 48 h, anchor limits) are ADR 0009 config and change by config version; a new ADR is needed only if the method changes in kind or the tier function changes shape.

Terms: `neff` is the effective sample size `(Σw)²/Σw²`. z is the distance from the median in robust spreads, `(x - m)/s`. Half-width is the interval's wider side relative to the median.

| Part | Rule |
|---|---|
| Sample | ADR 0016 refresh query: `FIXED_PRICE\|BEST_OFFER`, DE, no price filter, 10 pages of 200. Never polls or preview (D-47) |
| Complete | Unique IDs ≥ eBay's `total` and no page refused by the budget governor, else `truncated`: no snapshot, old one used until 48 h, Ops alert and count |
| Eligible | FIXED_PRICE without AUCTION, no `itemGroupType`, EUR landed cost, in segment (ADR 0010), not junk or scam. Best Offer kept |
| Self-influence | Newest snapshot whose sweep began before the candidate's `first_seen_at`; reused by the pre-send recheck (ADR 0015) |
| Steps | 1 eligibility; 2 weights `0.5^(age/halfLife)`, age from `itemOriginDate` (fallback `itemCreationDate`, counted), half-life 14 d GPU, 7 d RAM; 3 median `m0`; 4 drop asks below 0.6 × `m0`; 5 drop modified z > 3.5; 6 `m`, q10, q20, q75, `s`, `neff`, interval |
| Spread | `s` = 1.4826 × weighted MAD; if 0, 1.2533 × mean absolute deviation around `m`; if 0, skip step 5 |
| Interval | `[Q(0.5 - 0.98/√neff), Q(0.5 + 0.98/√neff)]`, no seed |
| Anchor ratio | Simon enters a sold median of ≥ 10 sales. `r = m_at_anchor / sold_median` from a snapshot ≤ 48 h old, stored once (no such snapshot: no `r`, uncalibrated). Valid 30 days; r < 1 stored as 1; r > 1.5 rejected, Ops warning. 10, 30, 1.5 are unmeasured defaults. `R = m / r`, else `R = m` |
| Per-seller cap | `fv-1-capped`: weight × min(1, 2/k). Only if D-40 allows reading the seller |
| Stored | Step counts, Best Offer share, `neff`, n, quantiles, `s`, `r`, versions. No input rows or seller |

Tiers come from one ordered pure function, one bar and one z guard per tier: Unrated if no snapshot, older than 48 h, neff < 8, half-width > 0.15, or a sector priced only by the user's maximum. Then No-brainer (calibrated, neff ≥ 15, half-width ≤ 0.10, x ≤ 0.80 R, z ≤ -2.0); Good (x ≤ 0.92 R, z ≤ -1.25); Above market (x > q75); else Fair. x is gross landed × (1 + premium) for both buyer profiles, from `riskPremiumBp` (ADR 0027; company vs private guide, "What the profile changes"), 5% in config v1; the net basis is only for the band check and bid limit. Unrated alerts only on a watch maximum (ADR 0004). No "moving" flag in v1. Price columns follow ADR 0014.

## Alternatives considered

Rejected: bootstrap lower bound and one-sided 80% bound (move with n); sold data (no API access); three bars per tier (gaps); anchors via min() (biased low).

## Consequences

**Positive**: reference independent of supply; one tier per input.

**Negative**
- No-brainer needs Simon to enter anchors every 30 days.
- `r` absorbs price drift: `m_at_anchor` is today's ask median, the sold median spans 30 past days.
- Uncalibrated Good is labelled asking-price based and may sit at or above sold prices.
- At neff 8 to 14 the median can miss by more than the 8% Good margin; the z guard carries that band.
- Backtests are tighten-only (D-28); formatting edits under `pricing/` need a version bump.

**Risks**
- Market-wide ask spike: the median follows it. The ratio expires after 30 days; a person buys after every alert.
- Best Offer asks overstate prices: share stored; a later method version can down-weight them.
- One dealer's high asks lift the reference about 10% under `fv-1`.
- Over 2,000 items per feed: every sweep truncates. Phase 0 records `total`; split per product.
- eBay may revoke the keyset or suspend the operator's buying account.

## How we check it

- Golden tests on `fixtures/pricing/rtx3090-example.json`. Expected values: independent script from a different Claude Code session (or Simon), checked in the same PR by the fresh-context review. Weakened tests, fixtures or lock file are caught only by that review and Simon reading the diff.
- Seeded false-Good simulation at neff 8 to 14 (fixture).
- Property tests: one tier; tier never improves as price rises; same tier for both profiles at equal seller class and returns; input order irrelevant; `neff` ≤ n.
- Unit tests: duplicate IDs count once; AUCTION plus FIXED_PRICE and item groups excluded; new `m` uses the stored `r`; candidate uses the earlier snapshot.
- Poisoning: 10 asks at 0.5 × or 1.5 × median move `R` ≤ 3% / ≤ 10% (`fv-1`), ≤ 3% capped.
- `config.lock.json` gains `methods` (hash of `pricing/` per version); CI fails without a new entry; ADR 0009 adds the key in one line.
- No seller column in `fair_value` or `manual_anchor`.

## Revisit when

- Consecutive anchor ratios differ by over 0.15, or anchors stop.
- The Phase 5 backtest moves a bar, or precision misses D-08.
- False-Good rate at neff 8 to 14 too high: raise the Good neff gate in a new config version (D-25).
- Half of watched segments Unrated for two weeks.
- Two truncations in 7 days, or `total` over 1,600.
- Best Offer share over 40%, or Simon misses a move a "moving" flag would catch.
- D-40 decided, or eBay offers sold prices.
