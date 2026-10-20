# Decision register

Every decision the eBay deal monitor needs, with status and latest safe date. Simon Klimaszyk (founder, Intra AI) makes every call; Claude Code agents implement and never decide. ADR numbers refer to [../adr/](../adr/README.md).

Status: **Decided** (owner answered), **Deferred** (default stands until reopened), **Open** (default applies until confirmed at the deadline; **Open (test)**: settled by a Phase 0 measurement), **Superseded** (replaced by an ADR or a later decision).

Deadlines: P0 = during Phase 0 (started Mon 19 Oct 2026); "before Pn" = before work in phase n starts.

## Licence and gates (D-05, D-06)

Anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use. Licence review is the operator's responsibility; out of scope for this repo.

- In force: gate 1a (a live production `EBAY_DE` search returns EUR results) and gate 3 (a person always buys through eBay checkout; no bidding or buying automation, no scraping, no browser automation; ADR 0002).
- Also in place: the account deletion endpoint (also needed to activate the production keyset), eBay call limits and the call budget (ADR 0016), minimal retention of listing content, no seller identifiers sent to Claude, no resale of data.

## Register

| ID | Topic | Status | Date | Answer or default | Deadline |
|---|---|---|---|---|---|
| D-01 | Owner, compliance owner, headcount | Decided | 2026-10-19 | Simon holds both roles. Estimates are for one person building with Claude Code agents; speed-up unmeasured, recalibrated after Phase 0 | — |
| D-02 | Account holder and billing | Decided | 2026-10-19 | Intra AI holds all accounts; Simon is account holder and billing owner. Exception: the GitHub repo is under his personal account (D-37). Secrets in Simon's password manager | — |
| D-03 | Domain and DNS | Decided | 2026-10-19 | `intra-ai.de`. App, dashboard, privacy page (`/privacy`) and deletion endpoint `https://deals.intra-ai.de/ebay/account-deletion` (no trailing slash). SES identity `alerts.intra-ai.de`, MAIL FROM `mail.alerts.intra-ai.de`. The A record for `deals.intra-ai.de` exists. To confirm: `drill.intra-ai.de` for the restore drill (Phase 0 S10), removed after each drill | — |
| D-04 | Buyer profile | Decided | 2026-10-19 | Company by default (Intra AI business eBay.de account). `buyer_profile` (`company` \| `private`) per watch, one profile per alert; private what-if in the dashboard, computed, never stored, never alerts. No claim convention or spend limit while Simon is the only buyer | — |
| D-05 | Gate 1 | Decided | 2026-10-19 | Gate 1 is gate 1a only | — |
| D-06 | Gate 2 | Decided | 2026-10-19 | Licence review is the operator's responsibility; out of scope for this repo | — |
| D-07 | Fallback and stop rule | Decided | 2026-10-19 | F1 (alerts on a maximum price set on the watch) is the first thin slice. 28-day review after the first production alert: stop if F1 is not clearly better than eBay's saved-search emails | — |
| D-08 | MVP metrics and review | Open | | Bought deals per month, share of alerts still available after 30 minutes, false alerts per day; one review 28 days after the first alert (ADR 0004). Before Phase 5 add precision (proposed 0.60) and at least 30 instant alerts in 28 days | P0 |
| D-09 | Slice order, unscreened alerts | Decided | 2026-10-19 | Via D-07: thin slices (ADR 0004). Slice 1 alerts are a digest labelled "not reviewed by Claude" | — |
| D-10 | Fair value on production data before gate 2 | Superseded | 2026-10-19 | Gate 2 is out of scope for this repo (D-06); fair value runs on production data | — |
| D-11 | Retention periods | Open | | `listing_content` and `evaluation_quote` deleted 6 hours after fetch or when the listing is gone; listing rows deleted when gone; `seen_item` 90 days; `evaluation`, `decision`, `alert` 180 days; `fair_value` 1 year; dumps exclude listing content and are kept at most 17 days (ADR 0025). Simon decides whether to keep ADR 0014's 30-day nulling of eBay-derived prices | Before P1 schema |
| D-12 | Environments and secrets | Superseded | | ADR 0011: environments are local, CI on fixtures, contract runs on the shared Docker host (counted in the call counter), `eval` and production; there is no staging; one secrets register | — |
| D-13 | Outbound calls, call accounting | Superseded | | ADR 0007: the worker makes scheduled calls, the server only short time-boxed ones; every eBay call goes through one Postgres counter, `app.reserve_ebay_call`; Price check is removed (D-47) | — |
| D-14 | Deletion endpoint behaviour | Superseded | | ADR 0013 and 0030: 204 to every POST up to 64 KB before parsing, then verify with a 1-hour key cache, no rate limit, external probe (D-38). Being built now (Phase 0 S3) | — |
| D-15 | Seller-scoped signals | Superseded | | ADR 0013 detail 10; now depends on D-40 | — |
| D-16 | Item key | Open | | HMAC-SHA256 over legacy item ID plus variation ID, `key_version` column, key in the env file and Simon's password manager, never in backups; rotate only on leak; confirm with a multi-variation fixture | P0 |
| D-17 | Fixtures | Superseded | | ADR 0023: synthetic fixtures built from Zod schemas checked against the pinned OpenAPI file; no committed production responses; no sandbox adapter | — |
| D-18 | GDPR and the Claude data flow | Open | | ADR 0018: contact data masked, no seller identifiers sent, Anthropic DPA, legitimate-interest note, record of processing, Art. 14 text on the privacy page; ask about zero data retention. No household exemption | P0 (privacy page) |
| D-19 | SES mode | Open | | Request production access in week one (up to 96 hours); account-level suppression list; MAIL FROM `mail.alerts.intra-ai.de`; DMARC `p=none` without `rua`; SQS only if bounces occur | P0 |
| D-20 | Supply, region, query shapes | Open (test) | | Measure supply in weeks 2 to 3 within the 400-call cap; `deliveryCountry:DE` and an item-location filter on every query; Germany only if the EU region filter warns. EU sellers are compared at gross (VAT class `foreign_seller`) | P0 |
| D-21 | Reference statistic | Open | | The weighted median is the reference price; its interval half-width is used only as a gate | Before P1 |
| D-22 | Ask-to-sold correction | Open | | Ask-to-sold ratio per segment from manual anchors; segments without a ratio are capped at tier Good | Before P1 |
| D-23 | Market check | Superseded | | ADR 0004: not in version 1; a Phase 5 experiment only with a written question (D-51) | — |
| D-24 | Dashboard screens | Open | | Four screens: Sign in, Deals (with profile what-if and feedback), Watches and Feeds, read-only Ops; settings through the audited CLI over SSH (ADR 0009) | Before P1 |
| D-25 | Starting thresholds | Open | | 0.80 and 0.92 of reference, neff 8 and 15, 3 instant alerts per watch per hour, 5% premium by profile (active from config v1, with tiers in Phase 2; phase-1 section 3), as config v1 after D-21 and D-22; backtest after 2 to 4 weeks | Before P2 |
| D-26 | Call budget and feeds | Superseded | | ADR 0016: one feed per leaf category, two call classes (`alert-path`, protected, and `standard`), at most 20 candidates per watch, new sectors on the 5/10 schedule; Growth Check per D-57 | — |
| D-27 | Item groups | Open | | Exclude item-group summaries from the sample and from alerts | Before P2 |
| D-28 | Backtest data | Open | | Tighten-only backtests in v1; a numbers-only candidate table (90 days) only if Simon wants looser thresholds | Before P2 |
| D-29 | Evaluation targets | Superseded | | ADR 0026: targets are held-out point estimates with Wilson intervals; alerts carry "screening not yet validated" until 40 scam and 40 legitimate held-out cases exist | — |
| D-30 | Image-only findings | Open | | BLOCK only after a second single-image call confirms; otherwise CAUTION | Before P3 |
| D-31 | Per-listing Claude failures | Open | | At least CAUTION and review queue, never instant; degraded mode only for global causes; server-side fallback off | Before P3 |
| D-32 | Model, budget, labelling | Superseded | | ADR 0028: Claude budget $10 a day (alert lane) and $1.50 a day (audit lane) in the first week, then reset from measured tokens; Simon labels a shadow sample of 5 a day for 4 to 6 weeks, then 1 | — |
| D-33 | Photo requirement | Open | | No hard minimum; fewer than 3 usable images gives at least CAUTION | Before P3 |
| D-34 | Review cadence | Open | | Same-day review while content exists (6 hours); content age on each label; later, label from codes and scores | Before P3 |
| D-35 | Langfuse | Open | | Eval runs only; the production audit record is the evaluation table in Postgres | Before P3 |
| D-36 | Auctions | Open | | Slice 4 after the Phase 3 exit. Bid limit `effectiveMaxBid` from the watch maximum, price basis and premium; formula and golden cases (max EUR 500, shipping EUR 6.99: 559.68, 588.01, 469.20, 493.01) in ADR 0032. Digest first, instant T-60 alerts on a D-44 go; computed ceiling after the first calibration round | Before P4 |
| D-37 | GitHub plan and review controls | Decided | 2026-10-19 | Public repo under Simon's personal account, GitHub Free. Since 2026-10-20 a ruleset on `main` requires a pull request with green `checks` and `zizmor`, no force-push or deletion. By convention: a fresh-context Claude Code review before merge; Simon's go before production deploys. Dropped: managed-settings file, separate macOS user, review script, required reviewers, Pro upgrade | — |
| D-38 | External probe of the deletion endpoint | Superseded | | ADR 0030: UptimeRobot keyword monitor every 5 minutes with `DELETION_PROBE_CODE`, plus the healthchecks.io `deletion-probe-seen` check; fallback an hourly GitHub Actions probe (about 720 minutes a month) | — |
| D-39 | Baseline question to eBay | Superseded | 2026-10-19 | Out of scope for this repo (D-06); baseline alerts run | — |
| D-40 | Seller username in memory | Open | | Browse schemas do not read `seller.username`, so the "three identical listings from one seller" signal and the per-seller cap (`fv-1-capped`, ADR 0017) stay off. Turning them on is Simon's call; even then no seller key is stored and no seller identifier goes to Claude | Before P2 |
| D-41 | T-15 "last call" email | Open | | Only if no T-60 alert went out, opt-in per watch | Before P4 |
| D-42 | CAUTION auctions | Open | | Never instant; "Ending soon" with the red-flag box; in the next hourly digest only if it ends at least 45 minutes later | Before P4 |
| D-43 | Auction call budget | Open | | 200 calls a day across all feeds, reset after the S1 measurement week | Before P4 |
| D-44 | Instant auction alerts go/no-go | Open | | At least 5 estimated alertable auctions a week in the S1 measurement week; otherwise digest only | Before P4 |
| D-45 | Tiers before screening | Open | | Tiers label and sort until slice 3; route from `decideSlice1`; shadow route stored (AC-19). `business_no_returns` switches on in Phase 3a (phase-1 section 3) | Before P2 |
| D-46 | Screener PASS rate | Open | | At least 0.80 on alert-eligible legitimate cases, with its Wilson interval | Before P3 |
| D-47 | Price check screen | Open | | Drop from version 1; watch preview instead (`limit` 50, no aggregate, per-user cap 40); revisit in Phase 5 | Before P1 |
| D-48 | Ops alert recipients, DMARC reports | Decided (DMARC reporting deferred) | 2026-10-19 | Ops alerts and the eBay portal alert address go to Simon; DMARC `p=none`, no `rua` | — |
| D-49 | Terms and pages diff | Open | | Simon, monthly from Phase 0 exit; agents prepare it. API License Agreement (footer "Sept 3, 2025"), deletion page, call limits, User Agreement, vendor terms, Anthropic deprecations | P0 |
| D-50 | Correct alert and labels | Open | | Labels "Real deal, bought", "Real deal, not needed", "Price not good enough", "Wrong product", "Scam or suspicious", "Gone before I looked". Precision = real-deal labels / all but "Gone"; false alert = the three negative ones | Before P1 |
| D-51 | Phase 5 extras | Open | | Telegram if over 30% of instant alerts are first viewed after 30 minutes (4 weeks, 30+ alerts); duplicate-photo check at 3 missed stolen-photo scams a month; else dropped | Before P5 |
| D-52 | Pilot sector | Open | | Desktop CPUs, current and previous generation, one feed on the 5/10 schedule | Before P5 |
| D-53 | Gate 2 consent for new categories | Superseded | 2026-10-19 | Gate 2 is out of scope for this repo (D-06) | — |
| D-54 | Config change approval | Open | | At most one calibration round a month; Simon merges its pull request after CI and the fresh-context review; emergency tightening any time, recorded afterwards (ADR 0033) | Before P5 |
| D-55 | getRateLimits and the Browse pool | Open (test) | | Budget 96 reads a day in the Browse pool until a contract run shows Browse `remaining` does not drop | P0 |
| D-56 | Gaming PC sector | Open | | In version 1: Phase 1 S10 if supply is about 5 listings a day and S1 to S9 are on time, else first item of Phase 2 | Before P1 |
| D-57 | Application Growth Check | Open | | Over 5,000 Browse calls a day needs the Growth Check. Stay within the default pool in version 1; if more calls are needed, Simon decides whether to apply | Before exceeding 5,000 calls a day |
| D-58 | Claude Code isolation | Superseded | 2026-10-19 | D-37 drops the separate macOS user and managed-settings file | — |
| D-59 | EPN acceptance | Superseded | 2026-10-19 | EPN is not used | — |
| D-60 | EPN questionnaire timing | Superseded | 2026-10-19 | EPN is not used | — |
| D-61 | Leaving EPN | Superseded | 2026-10-19 | EPN is not used | — |
| D-62 | Input tax and legal form | Open | | Simon records both on the Phase 0 owner checklist. Until then `inputTaxDeductible` is `false` (gross) and the § 377 HGB line is conditional. Under § 19 UStG input tax is probably not deductible | P0 |
| D-63 | Company seller-returns values, § 307 BGB | Open | | Medium / Medium as provisional values (ADR 0027); check § 307 BGB before the rules switch on; until then the checklist says warranty may be excluded | Before the rules switch on (P3a) |

## Other owner decisions on 2026-10-19

- **Hosting** (replaces ADR 0012's dedicated VPS with Caddy): own Compose project in `/opt/ebay-sniper` on a shared Docker host behind Traefik v3.6; containers bind to 127.0.0.1 only (server on `127.0.0.1:3140`); Postgres in its own container. Backups follow the host's backup practice plus our own dump without listing content. The host is shared, so jobs may be delayed, and the deletion endpoint needs the external probe (D-38).
- **eBay status**: developer account and an application with sandbox and production keysets exist; the production keyset stays disabled until the deletion notification subscription is saved.

## Sources

- eBay API License Agreement (trailing slash required): https://developer.ebay.com/join/api-license-agreement/ (read 2026-10-19)
- Marketplace account deletion: https://developer.ebay.com/marketplace-account-deletion
- API call limits: https://developer.ebay.com/develop/api/buy/api_call_limits
- SES production access: https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html
