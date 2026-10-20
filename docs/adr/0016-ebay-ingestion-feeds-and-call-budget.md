# ADR-0016: Feeds, query shapes and the eBay call budget

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0003, 0004, 0007, 0008, 0009, 0010, 0011, 0012, 0015, 0017, 0024; D-20, D-26, D-27, D-55, D-57

## Context

- Browse allows 5,000 calls a day for all methods but getItems; getItems (Limited Release) and Analytics have own pools; more needs the Growth Check ([call limits](https://developer.ebay.com/develop/api/buy/api_call_limits), read 2026-10-19).
- Both location filters give error 12517; a region filter can be ignored with warning 12519 ([filters](https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html)). `q` is cut at 100 characters without an error.
- `FIXED_PRICE` can return auctions with Buy It Now; `newlyListed` never sees price drops; item groups show one variation's price.

## Decision

A feed is one Browse search on EBAY_DE over one leaf category with an OR keyword list, a fixed filter and a day and night schedule; a `poll-tick` job picks due feeds (ADR 0008). A nightly refresh with no price filter gives the fair-value sample. The budget (`packages/domain/src/budget/`) plans only lines the active modes need, stays under 80% of the reported limit, counts per eBay pool and paces against the getRateLimits `reset`, not midnight.

**Query shapes** (one builder in `packages/ebay`):

| Path | Shape |
|---|---|
| Poll | `newlyListed`, 200 per page, up to 3 pages, `EXTENDED`; `deliveryCountry:DE`, `itemLocationCountry:DE`, `price:[floor..ceiling]`, EUR, `{FIXED_PRICE\|BEST_OFFER}`; ENDUSERCTX `contextualLocation=country%3DDE%2Czip%3D80331` |
| Cheap sweep, hourly | same, `sort=price`, 1 page, stores `sweep_cutoff_price` |
| Refresh, nightly | same, no price filter, up to 10 pages |
| Auction sweep | `endingSoonest`, `AUCTION`, ending within 4 h (ADR 0032) |

- Polls leave out auctions: the price filter applies to the current bid, so every new 1-euro auction would pass.
- `itemLocationRegion:EUROPEAN_UNION` only after a contract test shows no warnings (D-20).
- The floor defaults to 40% of the lowest watch maximum, an unsourced guess that week-one data replaces.
- Item groups (D-27) and `AUCTION` summaries are dropped from sample and alerts and counted; Best Offer stays, flagged.
- A poll pages on only while a whole page is unseen; page 3 still all unseen sets `cap_reached` and sends an ops email.
- A drop to or below the sweep cutoff is seen within about an hour; above it, only by the refresh, up to about 24 h later. In slice 1 the refresh is off, so drops above the cutoff are not detected. A refresh over 10 pages sets `refresh_run.truncated`; listings beyond it get no price-drop detection.

**Budget lines** (calls a day; the first five are per feed):

| Line | Calls | When |
|---|---|---|
| Polls every 2 min by day, 10 at night (5/10: 5 by day) | 528 (240) | always; day 07:00 to 23:00 Berlin |
| Cheap sweeps | 24 | always |
| Refresh | 20 | fair value on; never user-max sectors |
| Auction sweeps | 17 | auctions on |
| Overflow pages | 30 | always |
| Quota reads | 96 | until the pool test passes (D-55) |
| On-demand | 200 | 5 users x 40 per window |
| Contract runs | 50 | always |
| Screening getItem | 30 | screening on |
| Auction checkpoints | 200 | auctions on |
| Alert path | the rest under 80% | 3 calls per candidate |

A watch may produce 20 candidates a day (starting value). Extra candidates are recorded as `budget_skipped`; polls are never shed for them.

**Golden figures** (limit 5,000, all feeds 2/10):

| Case | Before alert path | Remainder | Candidates a day | Watches at cap |
|---|---|---|---|---|
| Slice 1, 3 feeds | 2,092 (41.8%) | 1,908 | 636 | 31 |
| Slice 1, 4 feeds | 2,674 (53.5%) | 1,326 | 442 | 22 |
| Slice 1, 5 feeds | 3,256 (65.1%) | 744 | 248 | 12 |
| All layers on, 3 feeds | 2,413 (48.3%) | 1,587 | 529 | 26 |

When demand does not fit, on-demand calls are refused first, then overflow pages stop, then cheap sweeps, then feeds drop to the night interval. Alert-path calls stop only at `remaining` 0; `remaining = min(eBay, limit - local count)`. The 80% is a code constant; caps and schedules are audited settings (ADR 0009). One production keyset (ADR 0011). If the pool gets tight, Claude Code drafts a Growth Check with a getItems request and Simon files it (D-57).

## Alternatives considered

Rejected: a feed per product (571 calls a day; the fallback if OR lists fail); a category feed without `q` (deferred); 2-minute polls all day (90.8% for five feeds); getItems or Feed API (closed to new keysets); a sample from capped polls (biased low); expanding item groups (extra calls); scraping (gate 3).

## Consequences

**Positive**: eBay enforces location and floor; fair value never sees capped data; alert calls cannot be starved.

**Negative**: the floor hides real cheap listings; item groups and auctions with Buy It Now are invisible in version 1; relists count twice; in slice 1, drops above the sweep cutoff are missed.

**Risks**: OR splits terms (contract test, product feeds). Over 600 new listings per interval (page-cap alert, narrower keywords). Expensive products in a mixed feed see drops a day late (Ops flag, then a narrower feed). Counts drift (use the lower, log the gap). The shared host (ADR 0012) delays polls. A Growth Check invites eBay review of the layers in use (file only if tight; describe only live layers).

## How we check it

- Property: no plan above 80%; standard calls never break the alert floor; fixed shed order; no refresh charged when off or user-max.
- Golden: 552, 264, 572, 589, 569 per feed; 2,092, 2,674, 3,256, 2,132, 2,413; plan 571 (283 on 5/10), 3,581, 4,152.
- Unit and lint: exact ENDUSERCTX; `q` over 100 characters rejected; never both location filters.
- Domain: fair value errors on any observation whose `source_path` is not `refresh`; the sample drops every `AUCTION` summary.
- Contract: empty `warnings`; 400 on both location filters; multi-word OR; how `buyingOptions` treats Best Offer and auctions, before fair value is on; Browse `remaining` around a quota read.
- Ops page (ADR 0024): calls per pool and class, cap hits, skips, cutoff, delay p50/p95 (price drops split by `cheap_sweep` and `refresh`), a flag on watches above their feed's median cutoff.

## Revisit when

Week-one data exists; the region filter passes; skips pass 10% of a feed; a shared line overruns for a week; more than 80% or a second marketplace is needed; eBay limits or the Growth Check change.
