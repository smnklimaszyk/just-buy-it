# ADR-0010: Adding hardware sectors and marketplaces

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0005, 0006, 0009, 0012, 0014, 0016, 0017, 0024, 0026; D-04, D-20, D-26, D-27, D-37, D-48

## Context

- Sector rules sit in five or more places in shared code. The call pool limits sectors: a feed costs 552 calls a day on 2/10 minutes (264 on 5/10); five slice-1 feeds come to 3,256 of 5,000 before the alert path, and a sixth leaves 162 calls for the alert path under the 80% cap (ADR 0016).
- Browse search takes one category ID per request ([Browse OpenAPI](https://developer.ebay.com/api-docs/master/buy/browse/openapi/3/buy_browse_v1_oas3.json)): one feed per leaf category. RAM may need two feeds (1,104 calls a day) if DDR4 and DDR5 sit in different leaf categories.
- `itemLocationRegion` cannot be combined with `itemLocationCountry` ([filters](https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html)).

## Decision

Each sector is one module in `packages/domain/src/sectors/<id>/` implementing `SectorModule` (`version`, `leafCategoryIds`, `valuation: 'asking-price' | 'user-max'`, pure `classify`, `segmentKey`, `parseAttributes`, junk and fraud rules, prompt fragment, checklist) in a static registry; numbers, half-life included, live in the decision config under `sectors[id]`. The database stores `product(sector, segment_key, classifier_version, attributes jsonb, successor_id)`, `watch` and `feed_product`; rows an image does not understand are inert (skipped, logged, counted), never a startup failure, so rollback stays safe. Marketplace is a feed column fixed to `EBAY_DE`; EU sellers come via `itemLocationRegion:EUROPEAN_UNION`.

Rules:
- `SectorId` derives from `registry.ts`, the only way into sectors; `parseAttributes` is plain TypeScript (ADR 0006).
- `classify` uses summary fields only and rejects item groups (D-27). Stored listings are not reclassified (titles purged after 6 hours, ADR 0014).
- `product` is unique on `(segment_key, classifier_version)`; keys start with the sector id. `watch.buyer_profile` defaults to `company` (D-04).
- `feed(sector, category_id, marketplace_id check = 'EBAY_DE')`; `category_id` must be in `leafCategoryIds` (422 on Settings POST).
- `activeRows(registry, rows)`: active only if sector registered, version matches, attributes parse, category allowed; inert counts by reason go to `inert_row` (ADR 0024).
- A key change bumps `version` with an expand-only custom Drizzle migration: insert new rows from a literal old-to-new table, copy watches and feed links, set `successor_id`; never update keys or delete. It runs once under the advisory lock before server and worker start. A later contract migration removes old rows; rollback does not cross it.
- After the Drizzle and pg-boss migrations, migrate runs `checkProducts(registry)` and stops the deploy before the new image starts (ADR 0012 step 3). It fails only on rows the image owns (current version not parsing or re-keying; older version with active watch, no successor, not retired); other rows are only counted, so a rollback re-run passes.
- A new sector PR adds module, registry line, config version, Taxonomy leaf IDs, 7-day supply and feed cost; it starts on 5/10 minutes (D-26). Over the 80% cap it waits for the Growth Check, covers fewer leaf categories or replaces a feed.
- PRs merge after CI and a separate agent's fresh-context review; Simon's go precedes production deploys (D-37).
- Version 1: `gpu`, `ram` (asking-price), `gaming-pc` (user-max). Segments with neff below 8 stay Unrated, alerting on the watch maximum (ADR 0017); no pooling.
- Accepting needs one-line updates to ADR 0009 and 0017 (half-life in config), 0005 (`checkProducts` last migrate step), 0024 (`inert_row`, Unrated-age metrics).

## Alternatives considered

Rejected: segment schemas as data with pooling (title rules are code-like); shared switch statements; failing startup on unknown rows (breaks rollback); a database rules engine (escapes review, ADR 0009); feeds per marketplace (full feed cost; the EU filter is free); gaming PCs as sum of parts (errors compound).

## Consequences

**Costs**: `attributes jsonb` is checked in code; prompt fragments multiply eval runs (ADR 0026); watch edits after a key bump are lost on rollback.

**Risks**:
- Category tree changes: the contract job checks each ID via Taxonomy `get_category_subtree` (`leafCategoryTreeNode: true`, `categoryTreeVersion`); `get_expired_categories` finds replacements.
- Region filter misbehaves: contract tests fail on warnings; fall back to `itemLocationCountry:DE` (D-20).
- Aspects only in `getItem` (no `localizedAspects` in summaries): classify on the summary, use enrichment only for passing listings.
- Rows inert by mistake: `ops-alerts` fires when `invalid_attributes` or `category_not_allowed` stays above zero an hour (D-48); `unknown_sector` and `other_version` are expected after a rollback, no alert.

## How we check it

- `sectorModuleContract` per module: deterministic `classify`, prefixed keys, item groups rejected, attributes round-trip, `leafCategoryIds` and `arrivalChecklist` not empty, a config entry with `halfLifeDays > 0` for asking-price.
- Golden fixtures (GPU: 3090 vs 3090 Ti, 4090 D, laptop, "nur OVP"; RAM: kit vs single, DDR4 vs DDR5, SO-DIMM).
- Postgres tests: each inert reason yields no poll, `fair_value` or alert, counted once; after a mapping migration `checkProducts` passes for new and previous registry, only `successor_id` changed; category, marketplace and unique-index checks.
- dependency-cruiser: only `registry.ts` imports `sectors/<id>/`. ESLint bans `sector` literal comparisons outside `sectors/` but misses local variables, `includes` or object lookups, template literals and raw SQL; review covers those.

## Revisit when

- A third asking-price sector is added, or a watched segment stays Unrated 28 days: write the pooling ADR. Unrated age (per watched product, days since the last passing `fair_value` row or watch creation) shows on the Ops page while fair value is on; `ops-alerts` opens a condition at 28 days; Simon owns it.
- Sectors must be added without a deploy, more than about 8 modules, or a third single-sector optional field.
- Growth Check decided, `getItems` granted, a second marketplace requested, or `itemLocationRegion` changes on EBAY_DE.
