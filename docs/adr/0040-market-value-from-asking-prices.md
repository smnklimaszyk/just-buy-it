# ADR-0040: Market value from asking prices (`mv-1`)

**Date**: 2026-10-22
**Status**: proposed
**Deciders**: Simon Klimaszyk (D-01)
**Related**: amends ADR 0014, 0016, 0017; ADR 0003, 0007, 0009, 0037, 0039; D-28, D-47

## Context

- v2 lets a product set its limit as "X % below the typical price, never above a cap" (ADR 0037; the owner's price-rule decision of 2026-10-22). That needs a market value per product.
- eBay sold prices are out of reach: Marketplace Insights is a Limited Release API "restricted and not open to new users at this time" (eBay Buy API docs, checked 2026-10-22). Browse `item_summary/search` gives asking prices, shipping to our postal code, condition, buying options, `itemCreationDate`, `itemOriginDate` (kept across relists) and `total` (Browse OpenAPI v1.20.4; notes `market-value.md`).
- ADR 0017 (`fv-1`, proposed, not built) is a weighted median per segment over a complete nightly sweep of up to 10 pages, with a hand-typed sold anchor and tiers. Segments are gone in v2, and 10 pages per product does not fit the 2,500-call plan.
- The eBay licence asks for the age of shown data older than 6 hours (8.1(c)) and deletion of copies no longer needed (3.1(b)), as summarised in ADR 0014.
- Owner decision 7 for the v2 spec, section 12 (2026-10-22): in market mode, use the last reliable value for up to 7 days, then the cap, shown as "using your cap".

## Decision

We compute `mv-1`, the typical asking price per product and condition group, as a weighted median of fixed-price asks from a 30-day pool of the product's own matching listings, refreshed by one nightly Browse search per product and by a few extra snapshots a day. In market mode the limit is that value minus the product's percent, never above its cap; without a reliable value under 7 days old the cap applies and is shown as "using your cap". The UI calls it "typical asking price", never a sold price.

### Sample

- The product's own rules, steps 1 to 6 of the matcher (ADR 0037), on the snapshot results; fixed price with or without Best Offer; landed price with known shipping to the postal code; DE location, EUR.
- One value per condition group the product watches (New, Open box, Refurbished, Used); groups never mix.
- Listings Claude called `wrong_product` leave the pool by item key. Only rows of the product's current `match_version` count. No Claude calls for the sample.
- A snapshot is one Browse search: the product's search words and category, its condition IDs, `FIXED_PRICE|BEST_OFFER`, DE, EUR, no price filter, `sort=newlyListed`, limit 200. Pages 2 and 3 only when `total` > 200 and the unread part would carry over 10 % of the weight; never more than 3 pages. Only snapshots fill the pool; the poll's sightings do not, so the pool keeps the snapshot's sampling (no price filter, newest first).

### Statistic (method constants, `MARKET_VALUE_METHOD_VERSION = "mv-1"`)

1. Per listing the landed price (per GB when `per_gb`) and weight `w = 0.5^(age / 14 days)`, age from `itemOriginDate` (fallback `itemCreationDate`).
2. Weighted median `m0`; drop asks below 0.6 x `m0`.
3. `m1` = weighted median of the asks step 2 kept; `s = 1.4826 x` their weighted MAD around `m1`; drop asks with `(x - m1) / s` above 3.5, high asks only (skip when `s = 0`). Centred on `m1`, not `m0`, so a scam ask that step 2 dropped cannot widen the spread and let a high ask back in.
4. Final weighted median `m`, weighted p25 and p75, `neff = (sum w)^2 / sum w^2`, interval `[Q(0.5 - 0.98/sqrt(neff)), Q(0.5 + 0.98/sqrt(neff))]`, half-width = wider side / `m`. Value = `m`. The weighted quantile `Q(p)` is the lowest price whose cumulative weight reaches `p` of the total, or the middle of two prices when the weight lands exactly on `p`.

Status, stored at compute time on the 30-day pool: `none` (neff < 8), `rough` (neff 8 to 14 or half-width > 0.15), `ok` (neff >= 15 and half-width <= 0.15). `capped` (3-page cap hit with more than 10 % of the weight unread) is a warning, not a status. "Out of date" is worked out when read: `computed_at` more than 48 h ago. Changing any constant here is a new method version.

### Limit

- `resolveLimit(product, conditionGroup, values, at, now)`, pure. Fixed mode: `max_cents`. Market mode: `v` = newest `ok` value with a price of the listing's condition group and the product's current `match_version`, computed before `at` and at most 7 days before it; when none came before `at` (the rules changed after the first sighting, or the purge removed that value's price), the newest one up to `now` that is at most 7 days old. Limit = `min(max_cents, (1 - pct/100) x v)` rounded down to EUR 10 (per GB to EUR 0.10), at least one step. Without `v`: limit = `max_cents`, marked "using your cap" in the products list, the product page and the email (owner decision 7). Floor: `floor_cents`, else the lower of 40 % of `v` and half the limit (so a percent above 60 still leaves a band), else 40 % of `max_cents`.
- `at` is the listing's first sighting (`seen_item.first_seen_at`, also written to `ebay_live.listing.first_seen_at`), so a cheap listing cannot pull its own reference down, and poll, enrich and screen resolve the same limit. The candidate stores `condition_group`, `limit_cents`, `price_mode` and `market_value_id`; the email, the product page and Claude get the same number.
- The poll reads a market-mode product from 10 % of its cap (fixed mode: 40 % of the max), since the market floor is 40 % of a value the planner does not know.
- The form shows per group the value, how sure it is (Reliable, Rough, Not enough listings, Out of date), the limit, the listings under it right now, details (middle half, precision, effective count, Best Offer share, what was removed) and the as-of time.

### Cadence and calls (amends ADR 0016)

| Run | When | eBay calls | `p_min_left` |
|---|---|---|---|
| Nightly snapshot | 03:00 to 05:00 Berlin, staggered, one per non-archived product | 1 to 3 | 2,000 |
| Created, rules changed, check now, category suggestion | From `app.market_request` and `app.category_request` | 1 to 3 | 2,500 |

Extra snapshots take a slot in `app.market_daily` (20 a Berlin day in total); check now also takes one of the person's 5 a day. The budget line is `3 x non-archived products + 60`. Before it writes `market_value`, the job re-reads `match_version` in the same transaction and discards its result when it changed.

### Data (amends ADR 0014)

| Table | Content | Lifetime |
|---|---|---|
| `app.market_listing` | Product, `match_version`, item key, condition group, landed price, unit total, dates, Best Offer, excluded reason. No title, seller or listing ID | Deleted 30 days after `last_seen_at` |
| `app.market_value` | Statistic, status, counts, method version | Price columns NULL after 30 days; row kept 1 year |
| `app.market_request`, `app.category_request` | Requests from the UI | 7 days |
| `app.market_run` | Calls, pages, total, error kind | 30 days |
| `app.market_daily` | Extra-snapshot counter | Class 3 |
| `ebay_live.market_preview` | Newest snapshot's titles and prices for "which listings counted" | 6 hours, like `classifier_sample` |

### Relation to ADR 0017

`fv-1` is not built in v2: no tiers, no sold anchor, no 10-page sweep, no per-segment half-life. ADR 0017 stays proposed for a later sold-price or tier step; `mv-1` reuses its weighting, trimming and interval steps on a smaller, per-product sample.

## Alternatives considered

- **`fv-1` as in ADR 0017**: a complete unfiltered sweep per segment, up to 10 pages a night per product; does not fit 2,500 calls with more than a few products, and needs segments.
- **The MVP price sample (`app.price_sample`)**: free, but only listings inside the poll's price filter, so it is cut at the ceiling and biased low.
- **Hand-typed sold median** (ADR 0017 anchor, spec version 1): closer to real prices, but manual work per product; moved to later.
- **Hold alerts when no reliable value exists** (owner decision 7 alternative): no alert above a stale market, but a new product would stay silent until it gets 15 effective listings.
- **Scraping sold listings**: against ADR 0002 and 0003.

## Consequences

**Positive**
- Every product shows a typical asking price per condition group within a day, at about 3 calls a product.
- The limit never exceeds the cap the person typed.
- The value, its inputs and its age are visible, so a person can judge it.

**Negative**
- Asking prices sit above sold prices; "X % below the typical asking price" is not "X % below what it sells for".
- Small markets stay at `none` or `rough` and alert on the cap.
- Large markets read only the newest 600 listings; `capped` warns about it.

**Risks**
- Sellers flood a market with high asks to raise the limit. Mitigation: the cap; outlier trimming; `at` before the listing's own sighting.
- A rules change leaves old rows in the pool. Mitigation: only the current `match_version` counts; the value is discarded when it changes during the snapshot.
- Market calls crowd out polls. Mitigation: higher `p_min_left`, the 20-a-day cap, the budget line in the plan check.

## How we check it

- `packages/domain/src/market/` golden tests on synthetic sets with expected values from an independent script; properties: order does not matter, `neff <= n`, a cheap listing never raises `m`, 10 asks at 0.5 x move the value at most 3 %, at 1.5 x at most 10 %.
- `resolveLimit` tests: per condition group, never above the cap, last `ok` value up to 7 days, "out of date" at 49 h and still used, the cap after 7 days and 1 minute, `capped` only a warning.
- `market-store` tests on Postgres 18: one row per listing with the latest price; "newest ok value of this group and match_version before a time" picks the right row; the 21st extra snapshot of a day is refused; purge follows the table above.
- Worker tests with a fake Browse: reserve before each call with the `p_min_left` above and stop when refused; a `match_version` change during the snapshot discards the value; paging stops at 3 pages; with 2,600 units used a check-now is refused while a poll passes.

## Revisit when

- Sold-price data becomes available (Marketplace Insights or a licensed source).
- Kleinanzeigen asks are live: they get their own line, not a share of this value.
- Live data shows the 14-day half-life or the gates (8 / 15, 0.15) misjudge markets.
- The plan check refuses saves because of the market line.
