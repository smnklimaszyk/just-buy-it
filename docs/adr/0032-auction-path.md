# ADR-0032: Auction path with the watch maximum

**Date**: 2026-10-19
**Status**: proposed (waits on D-36 and D-41 to D-44; accepted before phase 4 slice S2a merges)
**Related**: ADR 0002, 0004, 0014-0016, 0019, 0027, 0031, 0033; D-04, D-07, D-36, D-41 to D-44; [phase 4](../planning/phases/phase-4.md), [company vs private](../planning/guides/company-vs-private.md)

## Context

- Browse hides auctions unless `buyingOptions:{AUCTION}` is requested. `ItemSummary` has `itemEndDate`, `currentBidPrice`, `bidCount`; `minimumPriceToBid` (next valid bid) is on `Item` only (https://developer.ebay.com/develop/api/buy/browse_api.md, fetched 2026-10-19).
- eBay rejects some sort and filter pairs with error 12034. `AUCTION` with `sort=endingSoonest`, and `price` on the current bid, are unverified until the S0 contract run.
- Auction volume under a sensible limit is unknown.
- Each watch has `buyer_profile` (`company` default, or `private`, D-04), which sets the price basis and the risk premium.
- Anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use. A computed ceiling from the fair value still needs calibration first.
- The tool never bids (gate 3, ADR 0002); a person uses eBay's automatic bidding.

## Decision

Phase 4 (slice 4, ADR 0004) builds an auction path whose only bid limit is the watch maximum, read under the watch's `buyer_profile`; it works in F1 too (D-07). The computed ceiling is out of scope and gets its own record after calibration (ADR 0033, phase 5).

| # | Rule |
|---|---|
| 1 | **Discovery near the end.** Hourly sweep 07:00 to 23:00 (not 19:00) over `itemEndDate:[now..now+4h]`; 19:00 sweep to 09:00 next day, up to 3 pages. ADR 0016 shape builder: `AUCTION`, `sort=endingSoonest`, ceiling kept, price floor removed. 17 runs per feed per day. No tracking from first sight. |
| 2 | **Routes.** End inside the digest window (default 23:00 to 09:00): digest route, evaluated before the 21:00 digest, no checkpoints. Otherwise instant route. Found after that night's digest: `missed_digest`. |
| 3 | **Checkpoints.** T-150, T-60, T-15 as delayed jobs on `auction-checkpoint` (ADR 0015, `retentionSeconds` 86,400), scheduled in the same transaction as rows unique on (item_key, checkpoint). Catch-up runs T-150 at once if T-60 is 20+ min ahead. A job starting after end minus 5 min records `missed_checkpoint`, sends nothing. |
| 4 | **Bid limit.** `effectiveMaxBid(max, shipping, priceBasis, premiumBp, rateBp)` in cents: net `floor(max x (1+rate)/(1+premium))`, gross `floor(max/(1+premium))`, minus shipping, stepped to the largest bid where `basis x (1+premium) <= max` passes and one cent more fails. Bid is always gross. Net basis only under `company` with `vat_invoice_stated` and `inputTaxDeductible` (false until Simon confirms). Alert needs `minimumPriceToBid` at or below the limit. |
| 5 | **Verdict.** Instant email needs PASS (or F1 labelled "not reviewed by Claude") and the instant route. CAUTION per D-42. BLOCK and per-listing failures never email. Decision row records the profile; one alert, one profile. |
| 6 | **One alert per auction.** `alert.kind='auction_bid'`, checkpoint `t60`, `t15`, `digest` or `last_call`; partial unique index on `alert (item_key) WHERE kind='auction_bid' AND checkpoint<>'last_call'`. T-15 only if no T-60 alert went out or the watch opted in (D-41). |
| 7 | **Revisions.** Hash leaves out the bid, adds `sellerItemRevision` (ADR 0031). |
| 8 | **Budget.** "Auction checkpoints" line (ADR 0016), 200 calls a day across feeds until the measurement week resets it (D-43). At cap, new auctions are refused with a reason code. |
| 9 | **Go or no-go.** Instant alerts only if the S1 week shows at least 5 estimated alertable auctions a week (D-44); otherwise digest-only. |
| 10 | **Outcomes.** "Bid placed", "Won at EUR X", "Lost" from Simon. eBay final prices not recorded; `reservePriceMet`, `itemAffiliateWebURL` dropped in the parser. |

## Alternatives considered

- **Computed ceiling in phase 4**: needs a calibrated reference, and asking prices do not map to auction sold prices yet.
- **Digest only**: misses daytime auctions ending within hours; kept as the no-go outcome of rule 9.
- **Tracking from first sight**: early bids predict nothing, rows live up to 10 days, calls go to auctions that end too high.

## Consequences

- **Positive**: auctions reach Simon in time to set a maximum bid, with no price derived from listings; volume is measured first.
- **Negative**: a second scheduler path and alert kind; auctions starting and ending in one night are missed.
- **Risk, 12034 on the sort**: fallback drops the sort and pages the end-date window.
- **Risk, budget runs out**: cap, drop counter, reset after the measurement week.
- **Risk, bid limit above the watch maximum** (rounding, net basis): stepping against the band check, golden rows.
- **Risk, loaded shared host delays checkpoints**: late-job rule, T-15 backup, `digest_unscreened` ops email.

## How we check it

- Phase 4 acceptance criteria: idempotent scheduling across three sweeps, unique index, overnight window across both clock changes, cap, S0 contract.
- Property tests on `decideAuctionAlert()`: BLOCK never emails, CAUTION never instant, a higher `minimumPriceToBid` never turns `none` into `send_instant`.
- Golden `effectiveMaxBid()` rows (max EUR 500.00, shipping EUR 6.99, VAT 19%): net 5% EUR 559.68, net 0% EUR 588.01, gross 5% EUR 469.20, gross 0% EUR 493.01; band check passes at the limit, fails one cent above.
- Retention sentinel covers the auction tables and job payloads (ADR 0014).

## Revisit when

- The measurement week or later weeks fall below the D-44 threshold.
- Calibration exists and a computed ceiling is wanted (new record).
- eBay changes auction fields or filter rules.
- Simon confirms or denies input tax deduction.
