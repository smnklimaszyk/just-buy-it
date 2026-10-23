# ADR-0037: Products as data

**Date**: 2026-10-22
**Status**: proposed
**Deciders**: Simon Klimaszyk (D-01)
**Related**: supersedes ADR 0010 once accepted; amends ADR 0004, 0009, 0015, 0016, 0019, 0020, 0024, 0027, 0028, 0033; ADR 0002, 0005, 0014, 0018, 0036, 0038, 0039, 0040; D-04, D-26, D-37

## Context

- The MVP (`main` at 530d6fa) watches six hardware products. Their names, search words, categories, model checks, junk words and prompt text are code: `packages/domain/src/segments.ts`, `rules.ts`, `classify/classify.ts`, `packages/llm/src/prompt.v1.ts`, and the seed migration `0006_seed_feeds_rules.sql`. A new product needs a pull request, a review and a deploy.
- ADR 0010 planned one TypeScript sector module per hardware sector. The owner asked on 2026-10-22 for the opposite: no product defined in the repository, products added and edited by approved people in a form, any kind of product, not only hardware.
- Release 0 (530d6fa, deployed) is the rollback target: it tolerates unknown product keys (the candidate expires with `unknown_segment`) and unknown decisions, gives `prompt_injection` a code floor, and reclassifies by the candidate's own segment instead of `feed_id`.
- The eBay budget is 5,000 Browse calls a day; `app.reserve_ebay_call` keeps the 80 % hard cap (ADR 0007, 0016).
- Owner decisions for the v2 spec, section 12 (2026-10-22): 0 import today's six products as drafts from the database and finish them in the form; 6 a candidate Claude could not check is emailed marked "Not checked by Claude", with a per-product hold option, and cap-held candidates are retried after midnight; 8 planned ceiling 2,500 eBay calls a day; 9 eval spend approved up to USD 100; 10 candidate cap 10 a day for new products and 20 for imported ones, one product at most half of the daily Claude calls.

## Decision

We keep products as rows in Postgres (`app.product`, `app.product_source`, append-only `app.product_revision`), edited only through one audited save, `saveProductWithPlan()`, used by the web form, the ops CLI and the one-off import. The worker derives eBay searches from active and paused products, matches every listing with generic rules that read the product's own word lists, and sends only candidates to one product-neutral Claude call that also checks "is this the product the buyer described". No product name, search word, category or price lives in code.

### Data and save

- `app.product` columns, checks and condition groups as in the v2 spec, section 2.1. Keys: imported rows keep their segment key (`gpu_3090` etc., read from the database); new rows get `p_` plus 10 characters of `[a-z2-7]` from `crypto.randomBytes` (50 bits), retried up to 3 times on a conflict. A key never changes, and every history column called `segment` holds it.
- `version` is bumped by every write and used for the edit conflict check. `match_version` is bumped only when a matching field changes. `watch_from` is set on first activation and when search words, category or conditions change.
- `saveProductWithPlan()`: one transaction under `pg_advisory_xact_lock`, conflict check on `version`, write product, sources, revision and `app.audit_event`, rebuild `app.search` and `app.search_product`, compute the call plan, roll back above 2,500 calls a day (HTTP 422 with the numbers and the cheapest fix). The same lock and plan check run for `claude.daily_call_limit` and status changes.
- Words follow a fixed grammar checked in the Zod schema after folding (spec 3.2): whole tokens, `word*` prefixes, phrases of up to four tokens, `~word` for "not when negated"; 40 characters. Matching compares tokens. No RegExp is ever built from stored text.
- Today's six products: `ops products import-legacy` (actor `system:import`) reads `app.segment_rule` and `app.feed` rows once, writes six drafts through `saveProductWithPlan()` with `candidate_cap_per_day = min(copied, 20)`, `speed = normal`, `price_drop_check = true`, and refuses when any product exists. Simon adds exclude words, renames, describes and activates each draft in the form (owner decision 0). The suggested exclude words go into the manual test guide, not into the repo. The import command is removed seven days after v2 (spec V9).
- `app.feed` and `app.segment_rule` stay in the database, unread by v2, so Release 0 can still poll from them after a rollback. No contract migration in v2.

### Searches and budget (amends ADR 0016)

- Searches are derived, never edited: `planSearches()` groups active and paused products with an enabled `ebay` source by category, packs their search words into `q` up to 100 characters, splits on length or when the cheapest floor is below 5 % of the dearest read ceiling. Search ids are `s` plus a number from `app.search_id_seq`; they only go up and are never reused, and a search without members gets `retired_at` and is never deleted.
- Budget lines (spec 5.2): polls by speed preset, overflow 10 pages a search, 24 sweeps a day per product with `price_drop_check`, getItem `(effective Claude call limit + 2) x 3`, market `3 x non-archived products + 60`. The planned ceiling is 2,500 calls a day (owner decision 8), under the eBay 80 % cap of 4,000.
- Shed order through `p_min_left` (spec 5.4): polls and sweeps 1,500; nightly market snapshot 2,000; extra snapshots and category suggestions 2,500. Market calls stop before polls do.
- Baseline by listing age: a first sighting of a listing created before the product's `watch_from` records `baseline` (sticky). The poll writes nothing back to the product. The per-feed `feedHasSeenItems` baseline goes.
- What v2 writes into the legacy `feed_id` columns (`app.seen_item`, `app.poll_run`, `app.candidate`, `app.price_sample`, `ebay_live.listing`, `ebay_live.classifier_sample`): the `app.search.id` (`s<n>`) of the search whose poll wrote the row. A sweep, which runs per product, writes the product key (`p_...`), which stays the same when the product moves to another search. The legacy `segment` columns hold the product key (NULL in `seen_item` and `classifier_sample` when no product's must words matched), and `candidate.rule_version` holds `product.version`. The value is stable for the row's lifetime, never collides with Release 0's feed ids `gpu`, `ram`, `pc`, and Release 0 no longer reads it for reclassification; its dashboard shows it raw.

### Jobs (amends ADR 0015)

- Payloads, each checked by format: `poll { searchId }` (exclusive key `searchId`), `sweep { productKey }` (exclusive key `productKey`), `market-snapshot { productId }` (singleton key per product, concurrency 1), `category-suggest { requestId }` (concurrency 1), plus `market-nightly` and the held re-queue at 00:05 Berlin. A handler loads its row at the start and ends `paused` when it is gone, retired, paused or archived.
- Config reaches the worker without restart: products, sources, searches, settings and market values are read from Postgres at the start of each job. No cache, no LISTEN/NOTIFY. The edit-in-flight table of spec section 9 is the rule.
- `enrich` writes `prompt_version`, `model` and `effort` on the candidate when it hands off to `screen`; `screen` and its retry use them, so a settings change between attempts cannot open a second claim.

### Claude check (amends ADR 0019, 0020, 0028)

- `prompt.v2.ts` (at most 3,000 bytes, no hardware examples) and a user message of two JSON elements with `<` escaped: `<product>`, written by the buyer (name, description, must groups, exclude words, condition groups, `unit_min_total`, limit, market value and status), capped at 2,500 bytes, and `<listing>`, written by the seller. Name and description cannot contain `<`. Worst case per call: 18,500 input and 3,000 output tokens.
- Answers: `match` as today; `unclear` floors the verdict at caution; `mismatch` is not emailed, ends `wrong_product`, shows on the product's Deals tab and removes the item key from the product's market pool (this replaces the MVP rule of ADR 0020 that a mismatch gives caution and is emailed); a `prompt_injection` flag floors at caution and counts as `unclear` whatever the model said (Release 0).
- When Claude could not check (no key, cap, two failed attempts, timeout, refusal, wrong model), the alert goes out marked "Not checked by Claude: <reason>" (owner decision 6). With the product's `claude_required` the candidate is `held` instead. A candidate held because a daily cap was reached goes back on the screen queue at 00:05 Berlin when the listing is still live and was first seen under 12 hours ago; other held reasons are final.
- Settings `claude.model` and `claude.effort` offer only (model, effort) pairs with an entry in `SCREENING_EVALS` for the current prompt version. Spec step V7 runs the offline eval for Sonnet low, medium and high, Haiku medium and Opus medium before the deploy; the owner approved eval spend up to USD 100 (owner decision 9; the estimate is about USD 10). `CLAUDE_MODEL` leaves the env.
- Caps: settings `claude.daily_call_limit` and `claude.daily_spend_limit_usd`, bounded on save and on every reservation by `effective = min(setting, env ceiling)`. Per product at most `ceil(effective call limit / 2)` calls a Berlin day while two or more products are active, counted in `app.llm_usage_product_daily` in the same statement (owner decision 10). `candidate_cap_per_day` defaults to 10 for new products and 20 for imported ones (owner decision 10).

### Settings and constants (amends ADR 0009, 0027, 0033)

- `app.setting (key, value jsonb, version, updated_by, updated_at)`, a Zod schema per key in `packages/domain/src/settings.ts`, a missing row means the code default, every save audited. Keys: `claude.model`, `claude.effort`, `claude.daily_call_limit`, `claude.daily_spend_limit_usd`, `alerts.per_hour`, `alerts.per_day`, `alerts.default_buyer_profile`, `matcher.low_feedback_below`. Secrets never go into settings.
- `buyer_profile` is per product, defaulting to `alerts.default_buyer_profile` (amends ADR 0027, which had it per watch).
- Price and rule changes are product edits in the form or CLI, kept in `product_revision` and `app.audit_event`, not config pull requests (amends ADR 0033 for product rules; decision config and constants below still change by pull request).
- Code constants, changed by pull request: speed presets (fast 120 s / 600 s, normal 300 s / 600 s, slow 900 s / 1,800 s, day / night), overflow pages per search (10), `DEFAULT_JUNK_RULES` (marketplace words only, reasons from a fixed enum), extra-snapshot cap (20 a Berlin day), check-now per person (5 a day), Claude share per product (half of the daily calls). Market constants are in ADR 0040.
- Candidates store `product_version`, `match_version`, `condition_group`, `limit_cents`, `price_mode`, `market_value_id`, `prompt_version`, `model`, `effort` and `held_reason` (amends ADR 0009's provenance rule for v2).

### Sources

- `app.product_source (product_id, source, enabled, ka_saved_search_id, ka_price_limit_cents)` with `source` `ebay` or `kleinanzeigen`. Every product has an `ebay` row; the Kleinanzeigen checkbox stays disabled until the reader is live (ADR 0036).
- `app.candidate.source` already exists with the values `poll` and `sweep`. When Kleinanzeigen candidates join the pipeline later (spec V10, not built in v2), the new column that tells eBay from Kleinanzeigen is named `listing_source` (`ebay` | `kleinanzeigen`, default `ebay`), with the check `listing_source <> 'ebay' OR listing_id IS NOT NULL`.

### Observability (amends ADR 0024)

- The Overview, Budget and product pages of the admin UI (ADR 0039) replace the `127.0.0.1:3142` dashboard: plan by line against 2,500, quota against 4,000, Claude calls per product today, filtered-out counts by reason per product. `poll_run` counts `ambiguous` matches. When the stored plan is over 2,500 (hand-written SQL), `poll-tick` refuses all polls and the Overview shows a danger Banner.

### Modes (amends ADR 0004)

- F1's watch band and maximum become the product's price rule: `fixed` (max landed price) or `below_market` (percent below the market value of ADR 0040, never above the cap). Layer A's tiers are not part of v2. Layer B is the Claude check above.

## Alternatives considered

- **Sector modules in code (ADR 0010)**: typed and reviewed, but every product is a pull request and a deploy, and only hardware fits. The owner asked for products any approved person can add.
- **Shadow run of the six before switching (spec option 0b)**: keeps them identical for 3 to 7 days, but needs two releases and word lists in code until cleanup, 1 to 2 weeks longer. Not taken (owner decision 0).
- **Start empty (option 0c)**: loses prices, caps and history keys of the six.
- **Regex rules typed by admins**: flexible, but stored text reaching a RegExp is a ReDoS and injection path (security review S3). The token grammar covers the real cases.
- **A second Claude call for the product check**: doubles cost and calls; the product check fits the existing screening call.
- **Searches edited by hand**: lets the budget drift from the products; deriving them keeps one source of truth and one plan check.

## Consequences

**Positive**
- A new product is a form save: no pull request, no deploy.
- One save path for form, CLI and import: lock, plan check, revision and audit always apply.
- Generic matching and a product-neutral prompt make any product class possible; the guard test keeps hardware literals out of source.
- The budget can never be planned above 2,500 calls a day, and market calls are shed before polls.

**Negative**
- Matching quality now depends on the words people type; a product with weak words lets more listings reach getItem and Claude, bounded by `candidate_cap_per_day` and the per-product share.
- The import gives an alert gap of under an hour while Simon finishes the six drafts.
- More tables, revisions and audit rows to keep and purge (ADR 0014 rows in ADR 0038 and 0040).
- `app.feed` and `app.segment_rule` stay unread until a contract migration after the 30-day rollback window.

**Risks**
- A rollback to Release 0 meets rows with new keys and decisions. Mitigation: Release 0 tolerates them (11.1), a CI job runs Release 0 code against a database migrated to HEAD with v2-shaped rows, and product edits made in v2 do not flow back (runbook).
- Two concurrent saves that each fit but together exceed the plan. Mitigation: advisory lock and plan check inside the transaction; concurrency test.
- A hostile seller title tries to act as the buyer's product block. Mitigation: separate elements, `<` escaped, the prompt names who wrote each, hostile-title test.
- One product uses all Claude calls. Mitigation: per-product share and candidate cap.

## How we check it

- `tools/no-product-literals.test.ts` fails when files under `apps/*/src` and `packages/*/src` (including `testing/`, not tests, fixtures, migrations, evals or docs) contain `3090`, `4090`, `ddr4`, `ddr5`, `gpu_`, `ram_ddr`, `pc_4090`, `27386`, `170083` or `rtx`.
- `match.guard.test.ts` fails when `new RegExp(` under `packages/domain/src/match/` takes anything but a string literal; golden cases in `fixtures/match-cases.v1.json`, at least a third non-hardware.
- Planner tests: q packing and splitting, id reuse by overlap, a counter that never repeats a retired id, the worked numbers of spec 5.2 (204, 1,098, 1,962, +3, +27, +253, +541), and a loop over random product sets showing no plan above 2,500 is returned as ok.
- `config-store` tests on Postgres 18: save writes product, revision and audit in one transaction; two concurrent saves that together exceed 2,500 end with exactly one refused; a stale `version` is refused; same-second creates get different keys; matching edits bump `match_version`.
- Worker tests: polls per search with `feed_id` set to the search id, sweeps per product, `watch_from` baseline including a save during a poll, model change between attempts gives one claim, the per-product share refuses the 21st call with a limit of 40, `mismatch` gives `wrong_product` and no email, cap-held re-queue.
- Import test: on a database at 0006 with edited `segment_rule` rows, six drafts with the edited values; refused when any product exists.
- CI rollback job: Release 0 code against a HEAD database with v2 rows does not throw.

## Revisit when

- More than about 30 active products, or the plan check refuses saves more than once a week: revisit the 2,500 ceiling, speed presets or the eBay Growth Check.
- Kleinanzeigen candidates are built (spec V10): add `listing_source` as above.
- A product class needs a rule the token grammar cannot express.
- Sold-price data becomes available (Marketplace Insights).
