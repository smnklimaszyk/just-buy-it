# Critical review of the plan

Review of the Claude Design plan ("eBay Sniping Tool, Plan, nothing built yet"), 2026-10-19. Each finding survived a check by three reviewers (source, impact, remedy). Finding ids are stable; ADRs and phase plans refer to them. ADR numbers point to [`../adr/`](../adr/README.md), all still Proposed.

Markers: "Decision" means Simon must decide the item before its phase starts. "Decided (D-xx)" means the owner decision D-xx has settled it.

Terms: neff = effective sample size (Kish, after cleaning and weighting); MAD = median absolute deviation; Growth Check = eBay's application to raise the daily call limit; Unrated = the tier shown when the sample is too small or too spread to rate, so only the user's max price applies; order statistic = the k-th smallest value of the sample.

## 1. Verdict

The engineering foundation is sound: modular monolith on Postgres, pure domain logic built test-first, ports where eBay behaviour is unknown, retention designed in. Anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use. What still has to change before building:

1. Keep gate 1a (live production EBAY_DE search returns EUR results) and gate 3 (a person buys through eBay checkout; no bidding or buying automation, no scraping, no browser automation).
2. Ship thin slices, F1 max-price alerts first (H4, D-07).
3. Fix the reference statistic and the tier rules (H5, M17 to M21).
4. Make decisions auditable and the deletion endpoint robust (H6, H8).

## 2. What the plan gets right

- Gate 3 scope (ADR 0002): a person reviews and completes every purchase.
- Quota arithmetic (earlier plan's figures): 571 calls per feed a day; 5 feeds + 726 reserve = 3,581 (71.6% of 5,000); always-2-minute = 4,541 (90.8%). Now 552 per 2/10 feed (264 on 5/10) and 3,256 for five feeds before the alert path (ADR 0016).
- Browse details: FIXED_PRICE-only default, Buy It Now auctions losing FIXED_PRICE after a bid, contract tests against error 12034 and warning 12519, getItem COMPACT for rechecks.
- Deletion endpoint first, subscribed rather than opted out (https://developer.ebay.com/marketplace-account-deletion).
- No stored seller usernames or IDs, no reserve status, no training or embeddings on eBay content, no scraping.
- Robust statistics (one observation per listing, median, MAD, neff gates, Unrated tier, "asking-price based" label); fair value stored with method version, neff, interval and seed; I/O-free domain with golden tests.
- Two separate Claude jobs: tool-less evaluator with fixed schema; market check never sees a listing; verdict computed in code.
- Claude prices correct (Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50, Opus 5.5 $4/$20, web search $10 per 1,000; $23 to 32 a month).
- Stack size: two processes, one image, Postgres only, pg-boss 12, TypeScript 6 (typescript-eslint 8.71.2 supports below 6.1 only).
- Ports with kill switches; tested retention; expand-then-contract migrations; UTC tested across CEST to CET; Actions pinned by SHA.

## 3. Findings

### High

| Id | Finding | Recommendation |
|---|---|---|
| H1 | Gate 1 tested only that the key works; no stop rule. | Gate 1a is the Phase 1 entry condition; on failure Simon decides within 2 days (F2: eBay saved-search emails, or stop). Drop the sandbox ListingSource adapter. |
| H3 | No credible fallback product. Decided (D-07). | ADR 0004 ladder: F1 max landed price per watch plus deterministic junk and scam rules; F2 stop; 28-day review after the first production alert. |
| H4 | First useful alert only at the end of Phase 3. Decision. | Slices in production: (1) feeds, rules, max price, SES email, Deals list; (2) fair value and tiers; (3) Claude screening; (4) calibration; auctions and market check last. Decide whether unscreened alerts go out first as a "not reviewed by Claude" digest. |
| H5 | The plan uses the lower 95% bound of the median as the reference price. That bound is an order statistic whose rank depends on the sample size, so the reference moves with supply, and the Good path for neff 8 to 14 rarely fires. Decision. | Use the weighted median as the reference. Use the interval half-width only as a gate (at most 10% for No-brainer, 15% for Good). Rerun the worked example. |
| H6 | The server also makes outbound calls (getPublicKey, OTP email, Price check, Refresh); two processes give two call budgets. Decision. | Long and scheduled work in the worker, short time-boxed calls allowed in the server; call accounting in Postgres. ADR 0013: challenge from env plus fixed ENDPOINT_URL; ack every POST up to 64 KB with 204 before parsing, verify afterwards with a 1-hour key cache, log if the DB is down; up to 1,500 notifications a day; app-level rate limiting with the deletion path exempt; replay contract test. |
| H7 | No environment matrix or secrets inventory. Decision. | ADR 0011: local, CI (no secrets on push), manual contract workflow, production, no staging (shared 5,000-call pool). Secrets table with owner, location, rotation; HMAC key backed up in the password manager; service-account Anthropic key with spend limit; least-privilege SES IAM user. Accounts per D-02, domain per D-03. |
| H8 | Decisions cannot be audited: only fair_value is versioned, inputs are deleted, settings have no history. | ADR 0009: thresholds and rubric as numbered code artefacts; settings with append-only history; retention limits as code constants; store versions, commit SHA, seed, exclusion counts, model_id, prompt and rubric versions on every row; model-upgrade note (5.5 models retire no sooner than Sept/Oct 2027). |

### Medium

| Id | Finding | Recommendation |
|---|---|---|
| M1 | Call budget caps the product at about 5 feeds (a 6th gives 83%). Decision. | ADR 0016: budget is the scaling resource; floor for alert-path rechecks; new sectors on 5/10-minute schedule; Growth Check only per D-57. Measure polling delay on the shared host, where load can delay jobs (L13). |
| M2 | No delivery, location or price-floor filter. | `deliveryCountry:DE,itemLocationCountry:DE,price:[floor..ceiling],priceCurrency:EUR`; floor near 0.4 x reference, configurable per feed. itemLocationCountry and itemLocationRegion are mutually exclusive; an unsupported region filter returns HTTP 200 with warning 12519, so contract tests assert no warnings. Build the ENDUSERCTX header with a URL encoder. For auctions the price filter applies to the current bid, so new EUR 1 auctions pass it. |
| M3 | newlyListed sorts by itemOriginDate, which survives relists. | Measure delay from itemCreationDate; report relists; stop claiming relist dedup. |
| M4 | Item groups not handled (getItem fails with 11005). Decision. | Exclude group summaries from sample and alerts in v1. |
| M5 | Sample censored by the feed ceiling and mixed with auctions, Best Offer and the candidate. | ADR 0017: unfiltered refresh sample, FIXED_PRICE only, Best Offer flagged, candidate judged against the earlier fair_value. |
| M6 | "Gone" is undefined. | gone_at and gone_reason; gone = getItem ended, end date passed, or missing from two full sweeps; exclude rows unconfirmed for 48 hours. |
| M8 | 6-hour and 24-hour rules are display-freshness rules, not deletion rules. | Split eBay's rules from internal policy; delete rows when no longer viewable; "as of HH:MM" on every display including email. |
| M9 | Anthropic keeps API data up to 30 days (flagged content 2 years, scores 7 years); seller text holds personal data; no GDPR steps. Decision. | ADR 0018; service-provider register; mask phones, emails, IBANs; no seller identifiers to Claude; Anthropic DPA, legitimate-interest note, record of processing; ask about zero retention. |
| M10 | Same-seller fraud signal needs a seller key. Decision. | ADR 0013: HMAC on the 24-hour listing row only, or an in-memory window; never sent to Claude. |
| M11 | Buyer status drives law, account type and rules. Decided (D-04). | buyer_profile (company or private) per watch, company default, one per alert, private what-if never stored; business eBay account for company buys; inputTaxDeductible false until VAT status is confirmed. |
| M12 | Recorded production fixtures in git conflict with retention. | Fixtures from the OpenAPI schema with made-up data; live recordings outside the repo (ADR 0014). |
| M13 | pg_dump 17 refuses PG 18; dumps carry listing data; no encryption or retention. | pg_dump from postgres:18; mount the volume at /var/lib/postgresql (postgres:18 moved its data path; a PG 17 compose example would lose data); exclude data of one ebay_live schema; encrypt with age; keep the host's own backups plus our own dump without listing content, with retention; sentinel test; RPO 24 hours. |
| M14 | pg-boss keeps raw item IDs in payloads for days. | Payloads carry the internal listing key; short deleteAfterSeconds; sentinel scan. |
| M15 | Item-ID hash has no defined input or versioning. Decision. | item_key = HMAC-SHA256(key, canonical_id) with key_version; one item in two feeds gives one key. |
| M16 | Blocked items reviewed after the evidence is gone. Decision. | Daily same-day sample while content exists. |
| M17 | Asks sit above sold prices; anchors have no rule. Decision. | Store manual sold anchors and the ask-to-sold ratio per segment; cap segments without a ratio at Good. |
| M18 | Worked example fails its own z rule (EUR 1,000 at z -1.15). | Publish the 30 values as a fixture, define robust z, derive golden tests. |
| M19 | Tier rules overlap and leave gaps. | One ordered tier function; property test: exactly one tier, monotone in price. |
| M20 | Poisoning gaps (one seller, high-side asks, circular cleaning). | Ordered cleaning passes; seller weight cap from an in-memory key; golden tests. |
| M21 | Age weighting and "moving" flag undefined. | State purpose, report neff with and without weights, define or drop "moving". |
| M22 | Backtest cannot loosen thresholds. | State that only tightening is backtestable. |
| M23 | No shape for adding a sector. | watch and feed_product tables now; one module per sector (ADR 0010). |
| M24 | Image findings cannot be quote-verified. Decision. | Evidence type; Unicode normalisation; image BLOCK only after a second call (ADR 0020). |
| M25 | 20 to 30 cases cannot show 90% scam recall. Decision. | Held-out split, 35 to 40 scam cases, regression gate, "screening not yet validated" label. |
| M26 | Injection can suppress findings. | Deterministic marker scan before Claude; any hit blocks PASS. |
| M27 | Refusals route a listing to the unreviewed path. Decision. | Per-listing refusal or parse failure is at least CAUTION; no server-side model fallback (ADR 0019). |
| M28 | Cost omits thinking tokens and image size. 8 images at 1600x1200 are about 19,952 tokens, at the 2,576 px cap about 38,272; Sonnet 5.5 bills adaptive thinking as output. | Assume $0.07 to $0.17 per evaluation in the cost model; measure with count_tokens and the usage object in Phase 3 week one; define which 8 of up to 24 images are sent. |
| M29 | Budget guard can be spent on low-value items. | Queue by tier and discount; separate small budget for shadow and market checks. |
| M30 | Dependency rules only for domain. | ADR 0006 import graph enforced by lint. |
| M31 | A crash can pay for a Sonnet call twice. | Claim the evaluation row before calling; transactional enqueue; stop_grace_period 120 s; crash-replay test. |
| M32 | One migrate command undesigned. | drizzle-kit plus pg-boss migrations in one advisory-locked step; migrate: false in apps. |
| M33 | Better Auth defaults (plain OTP, sign-up on, in-memory limiter), no CSP. | ADR 0021: hashed OTP, sign-up off, DB rate limiter per IP and email, trusted proxy, strict CSP. |
| M34 | SES alignment and bounces undesigned. Decided (D-03, D-48). | alerts.intra-ai.de, MAIL FROM mail.alerts.intra-ai.de, DKIM, DMARC p=none without rua; suppression list. |
| M35 | Deploy and rollback undefined. | SHA-tagged images; pull, migrate, start, /healthz, roll back. The first deploy also checks the Traefik route file and that the "le" resolver issued the certificate for deals.intra-ai.de. D-37 controls: CI and a fresh-context review before merge, Simon's go before deploy. |
| M36 | 8 to 13 engineer-weeks is optimistic. | Re-estimated: phases 0 to 4 about 131.5 to 192.5 engineer-days (about 26 to 38.5 weeks), Phase 0 18 to 27, Phase 5 23 to 34, counted for one person without agents, before owner time and waits. The speed-up with Claude Code is unmeasured; recalibrate after Phase 0 (D-01). |
| M37 | No success metrics or kill criterion. Decision. | 3 to 5 numeric targets plus the 28-day review (D-07). |
| M38 | Ten screens for one user. Decision. | Four screens per D-24: Sign in, Deals (with detail view), Watches+Feeds, read-only Ops. |
| M39 | Auctions come before calibration. Decision. | Move auctions after calibration; "sniping" means finding deals, not bidding. |

### Low

| Id | Finding | Recommendation |
|---|---|---|
| L1 | 726-call reserve not itemised. | Itemise; pace against eBay's reset time. |
| L2 | Market check of doubtful value in Phase 1. | Move to Phase 5 as an experiment. |
| L3 | OR keywords untested; q over 100 chars truncated. | Contract-test; reject long q. |
| L4 | Auction sweep shape unspecified. | Contract-test; 11001/11004 mean ended; drop reservePriceMet. |
| L5 | Price drops missed by newlyListed. | State it; track that delay. |
| L6 | Auction ceiling double-counts shipping. | ADR 0032 formula; golden case max EUR 500, shipping EUR 6.99, gross 0% gives 493.01. |
| L7 | Quantile, MAD, neff, bootstrap undefined. | "Pricing method v1" in ADR 0017. |
| L8 | Nightly evals cost $81 to 114 a month. | Run on change and weekly. |
| L9 | Structured-output limits. | Limits in Zod; one retry. |
| L10 | Model tie-break and labelling load. Decision. | Cheapest model no worse on critical cases; 5 shadow items a day. |
| L11 | No external probe; Langfuse keeps 30 days. Decision. | External probe of the challenge hash; Postgres is the audit record. |
| L12 | Alert mixes decision and delivery. | Split alert and alert_delivery. |
| L13 | Restore and host failure modes. The app runs on a shared Docker host behind Traefik, so noisy neighbours can delay jobs. | Restore mode with worker off; memory limits and log rotation; external probe of the deletion endpoint (L11); backups per M13. |
| L14 | Host hardening. | Bind to 127.0.0.1 only (server 127.0.0.1:3140); never publish Postgres; route via /opt/traefik/dynamic/ebay-sniper.yml. |
| L16 | Version pins. | typescript ~6.0.3; Node 24, moving to 26 at LTS (ADR 0005); hold back TS 7, Hono 5, Drizzle 1.0. |
| L17 | Time handling. | Timestamp helper with time zone; store eBay's reset time. |

## 4. Out of scope

- H1 licence part, H2, M7: licence review is the operator's responsibility; out of scope for this repo. Fair value, tiers and the observation ledger do not wait on a licence gate.
- Parts of M9, M10, M11, M22, M39 that waited on licence review (AI use, seller scoring, seller-type rules, auctions) no longer wait on it.

Superseded by the hosting decision (shared server, Traefik): the earlier VPS and Caddy items; L15 removed.

## 5. Considered and rejected

| Id | Reason |
|---|---|
| ebay-api-12 | Zero-result feed metric shows a dead category. |
| ebay-compliance-11 | AGB reader already planned; run the terms diff with no end date. |
| ebay-compliance-12 | Internal dashboard is probably not a public display. |
| ebay-compliance-14 | Intra AI holds all accounts (D-02). |
| pricing-stats-9 | Goes away with H5. |
| pricing-stats-14 | Folded into buyer_profile (M11, D-04). |
| architecture-8 | No second marketplace planned. |
| architecture-9 | A per-minute tick is a valid design. |
| architecture-10 | Design preference; timing covered in L2. |
| architecture-13 | Simon is the only user. |
| architecture-14 | Style point; useful parts in M30, M32. |
| product-roadmap-7 | Requesting SES production access costs nothing (M34). |
| data-model-13 | Over-built; a read-time expiry filter suffices. |
| data-model-15 | Integer cents; one line in coding conventions. |

## Sources (checked 2026-10-19)

- https://developer.ebay.com/api-docs/buy/static/buy-requirements.html
- https://developer.ebay.com/marketplace-account-deletion
- https://developer.ebay.com/join/api-license-agreement/ (trailing slash; footer "Sept 3, 2025")
- https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
