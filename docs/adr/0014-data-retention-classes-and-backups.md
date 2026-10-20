# ADR-0014: Data classes, retention and gone rules

**Date**: 2026-10-19
**Status**: proposed (lifetimes and the 30-day price nulling wait on D-11)
**Related**: ADR 0003, 0005, 0009, 0018 and those cited below; D-11, D-34, D-48

## Context

- [Agreement](https://developer.ebay.com/join/api-license-agreement/): 3.1(b) delete copies when no longer needed; 8.1(b) when no longer public (no time limit); 8.1(c) disclose the age of displayed data older than 6 h; 4.1 binds service providers; 11.2 lets eBay post a new version at any time, and continued use counts as acceptance.
- We cannot see most listings end. Polls see only new items; a cheap sweep sees the 200 cheapest per feed (`sweep_cutoff_price`); the refresh sees at most 2,000 and sets `truncated` when `total` is larger (ADR 0016).
- Copies elsewhere: pg-boss 12 keeps completed jobs 7 d, open jobs 14 d, dead-letter queues copy payloads ([docs](https://pgboss.io/api/queues)). Anthropic keeps API inputs and outputs 30 d, flagged ones 2 years, trust-and-safety scores 7 years; a separate "Covered Models" rule is unverified ([page](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)).

## Decision

Three classes in separate Postgres schemas, each with one deletion rule (purge job every 15 min, schema test). `packages/db/src/retention.ts` is the authoritative registry (one row per table: class, lifetime, price-bearing columns). Backups hold class 2 and 3 only (ADR 0025).

| Class | Schema | Tables | Rule |
|---|---|---|---|
| 1 eBay content, raw IDs | `ebay_live` | `listing`, `listing_content`, `evaluation_quote`, `classifier_sample` | Content and quotes deleted at `content_expires_at` = min(fetch + 6 h, item end); `listing` and its rows once `gone_at` is set. No foreign key into `ebay_live` |
| 2 numbers and codes under `item_key` | `app` | `seen_item` 90 d (no prices); 180 d: `evaluation`, `decision`, `alert`, `alert_delivery`, `digest`, `review_label`; `fair_value` 1 y (current value plus 30 d of price history); `market_check` | Price-bearing columns (price, shipping, landed cost, quantiles, interval bounds, z-scores, seller feedback count and percentage) set to NULL 30 d after write; codes, verdicts, versions, costs keep the row lifetime. Lifetimes are assumptions (D-11) |
| 3 operational | `app`, `auth`, `pgboss` | config rows (watch incl. `buyer_profile`), `audit_event` 1 y, `poll_run` 30 d, `refresh_run`, `api_usage_hourly` 1 y, `quota_snapshot` 90 d, `deletion_event` 1 y, `deletion_result_hourly` 90 d (ADR 0013), `auth` (users, sessions, hashed codes) | Per registry row; no listing content |

A new table adds its registry row, with the lifetime from its phase plan, in the same pull request; the Phase 4 auction tables are class 2 with prices nulled at 30 d.

Gone rules (`last_confirmed_at` = last search hit or getItem response), first match wins (`gone_reason`):

1. getItem returns ended or not found, including the recheck before each send.
2. `itemEndDate` has passed, when the response carries one.
3. Missing from two consecutive non-truncated refresh runs.
4. Missing from two consecutive cheap sweeps while the last observed price was strictly below both sweeps' cutoffs and the item last matched the feed's canonical filter. It has then ended, risen above the cutoff or left the filter; purging is safe in all three cases.
5. Backstop: no confirmation for 48 hours (`unconfirmed`), the same window after which a row leaves the fair-value sample (ADR 0017).

Rule 3 fires only for a feed whose active set fits in 2,000 items, never in slice 1 (max-price mode) or for user-max sectors. Rule 4 covers only the cheapest 200 listings. All other rows rely on the backstop. No getItem is spent on stale rows (a 1,500-row feed would need about 750 calls a day against a 436 to 666 budget); rows near a send are confirmed by rule 1.

- Job payloads carry surrogate keys only (`{ listingId }`); a stale job finds no row and completes as a no-op. Queue retention is set in ADR 0015.
- Long-lived rows carry `item_key` and may carry `listing_id` as a plain uuidv7 column that points to nothing after purge. A purged live item returns with a new key, matched by `item_key`: no second evaluation or alert.
- Every display of eBay content, emails included, shows an as-of time in Europe/Berlin (ADR 0008, 0022). The dashboard keeps old rows; after purge a row shows codes and the as-of time with a Refresh action (getItem, class `standard`, purpose `item_refresh`, the user's ID; ADR 0007).
- Alert mail auto-deletes after 30 days (D-48). Fixtures are synthetic (ADR 0023). `docs/compliance/service-providers.md` (owner Simon, stub in Phase 0) lists each processor of eBay content: what it receives, how long it keeps it, contract terms, whether the 4.1 flow-down is in place.

## Alternatives considered

- **Separate databases per class**: breaks the one-transaction decide step (ADR 0015).
- **Column encryption**: deletes nothing. **7-day backstop**: keeps ended listings 5 more days for no gain.

## Consequences

**Negative**
- Backtests (Phase 5) see only 30 days of prices.
- The backstop purges live listings unseen for 48 hours; re-enrichment may cost a getItem.
- Blocked and sample items are reviewed the same day by Simon (D-34); otherwise labelled later from codes and scores, with the content age recorded.

**Risks**
- Ended listings stay up to 48 hours (the backstop is the main path).
- A gone rule silently never fires (every refresh truncated).
- Search inconsistency purges a live listing (two misses required).

## How we check it

- Schema test (CI, Postgres 18): every `ebay_live`, `app`, `auth` table has a registry row; every numeric `app` column is marked price-bearing or not; no foreign key into `ebay_live`; `seen_item` has no price column.
- Purge tests (injected Clock): content gone at 6 h, listing at `gone_at`, prices NULL at day 30, other columns kept.
- Gone-rule tests: truncated refresh never sets `gone_at`; sweep misses never purge a row at or above a cutoff; 48 h sets it, 47 h not; reinsertion matches `item_key`.
- Strict Zod payload test over every queue; `pgboss` sentinel test (ADR 0023); as-of time in every email, digest and dashboard row.
- Ops (ADR 0024): gone rows by reason per feed, truncated share, reinsertions, `last_confirmed_at` to deletion p50/p95; flag a feed with all refreshes truncated or absent for 7 days.

## Revisit when

- Simon decides D-11 or reads 3.1(b), 4.1 or 8.1 differently, or the agreement footer is no longer "Sept 3, 2025".
- Ops shows rule 3 or 4 sets most gone rows, or the backstop purges many live listings.
- A sector brings unregistered eBay fields, getItems batch becomes available, or Anthropic grants or refuses zero data retention.
