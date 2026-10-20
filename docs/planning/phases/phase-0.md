# Phase 0: deletion endpoint, walking skeleton, gate 1a

Status: in progress, 2026-10-19. Owner: Simon Klimaszyk (D-01). Agents implement; Simon reviews and deploys.

## 1. Goal

Prove the production path and EBAY_DE search before feature work. At exit: `https://deals.intra-ai.de` serves only `/ebay/account-deletion`, `/privacy` and `/healthz`, keyset active; a fixture listing flows through `packages/domain` into Postgres and an internal page; gate 1a is recorded; the searches Phase 1 needs are tested live; supply is counted; CI, deploy with rollback and a timed rebuild exist; SES is verified.

## 2. Ground rules

- **Licence:** anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use.
- **Built in:** deletion endpoint, call limits, minimal retention of listing content, no seller identifiers to Claude, no resale.
- **Gate 3** ([ADR 0002](../../adr/0002-human-completes-every-purchase.md)): a person buys through eBay checkout; no bidding or buying automation, scraping or browser automation.
- **Hosting:** a shared Docker host behind Traefik, project `/opt/ebay-sniper`, Traefik v3.6 (file provider `/opt/traefik/dynamic`, resolver `le`, middlewares `redirect-to-https`, `hsts-headers`), route file `ebay-sniper.yml`. Containers bind to 127.0.0.1 only (server `:3140`); Postgres is unpublished. Replaces the VPS and Caddy in [ADR 0012](../../adr/0012-hosting-and-deployment.md).
- **Repository (D-37):** personal GitHub Free, no branch protection. By convention: CI green and a fresh-context Claude Code review before merge; Simon reads the deletion-endpoint and `docs/adr/` diffs himself.
- **No live listing content stored.** Live calls keep metadata only (request ID, status, `total`, currencies, warning and error codes, field presence); nothing from eBay goes into git. In code, `LICENCE_GATES.storeLiveListings = false` blocks the live write path and the skeleton CLI accepts only `--source fixture` (acceptance criterion A14; A1 to A27: section 9).

## 3. Entry criteria

| Item | State |
|---|---|
| D-01 to D-07, D-37, D-48, hosting | Done 2026-10-19 |
| Sandbox and production keysets | Exist; production off until the deletion subscription is saved |
| DNS A record `deals.intra-ai.de`, no AAAA | Exists |
| SSH to the host, write access to `/opt/traefik/dynamic` | Yes |
| AWS, healthchecks.io, UptimeRobot (alerts to Simon) | Before S3 probe and S8 |
| Owner checklist (D-04): legal form recorded; input-tax deduction confirmed, else `inputTaxDeductible=false`; business eBay.de account open | Open (S0) |

ADRs accepted (merged by Simon) before their slice: 0001, 0005, 0006, 0011 (S1); 0007, 0008, 0023 (S1b); 0012, 0029 (S2); 0013, 0030 (S3); 0015 (S4); 0002, 0003 (S5); 0022 (S8). 0002, 0003 and 0012 are already rewritten for the shared host. 0004 and 0016 are accepted at exit or carried with a date. Others stay proposed ([ADR index](../../adr/README.md)).

## 4. Scope

**In:** the slices below. **Out:** login, stored live listings, polling (Phase 1); fair value, classifier, Claude; alert email; backups (Phase 1: `/opt/backups` plus our own dump without listing content); auctions. Anything else needs a written decision.

## 5. Slices

Days are engineer-days without agents; actuals are recorded per slice. Status 2026-10-19: S0 done except AWS, probe and checklist; S3 in progress (first deploy by hand over SSH on Simon's go) with the S1b and S2 parts it needs; the rest open.

| Slice | Deliverable | Depends on | Days |
|---|---|---|---|
| S0 Kickoff | Decisions recorded, accounts open, secrets in the password manager, owner checklist | none | 0.25-0.5 |
| S1 Repo, CI | A pnpm workspace with TypeScript `~6.0.3` strict (typescript-eslint 8.71.2 needs `<6.1.0`), Vitest, dependency-cruiser with self-test, Renovate. PRs run affected checks on Postgres 18; `main` runs all and builds the image, no push yet (ADR 0029). Node 24, moving to 26 at LTS (2026-10-28). | S0 | 1-2 |
| S1b Foundations | Drizzle, a `timestamptz` helper, an advisory-locked migrate runner (`apps/ops`); pg-boss and its schema come with the first job (S4). Tables `ebay_quota_window` with `reserve_ebay_call()`, `api_usage_hourly`, `deletion_event`, `deletion_result_hourly`. The eBay client has a token cache, 10 s timeout, typed errors and A20 retries; it reserves before each Browse call, `getPublicKey` excepted. Zod fixtures match Browse OpenAPI v1.20.4 (pinned, not committed). | S1 | 2-3 |
| S2 Edge, deploy | Compose, route and deploy script (below). Simon approves the privacy text. | S1 | 2-3 |
| S3 Deletion endpoint | Section 6. Subscription saved and keyset active, recorded in `docs/compliance/gates.md`. | S1b, S2 | 2-3 |
| S4 Skeleton | Section 7 | S1b, S2 | 3-4 |
| S5 Contract run, gate 1a | Query builder, warning classifier, contract CLI (section 8) | S3, S4 | 1.5-2.5 |
| S6 Supply | `docs/ebay/supply-2026-10.md`, counts only: `total` per segment (RTX 3090, 3090 Ti, 4090, DDR4/DDR5 by size, 4090 PCs), DE and EU, by buying option; arrivals per leaf category (4 a day, 3 days); item-group share; peak new items per 2 and 10 min against the 200-item page. Answers D-20; feeds D-26, D-27 and the D-08 check (section 11) | S5 | 1-1.5 |
| S8 SES | eu-central-1, Easy DKIM, MAIL FROM `mail.alerts.intra-ai.de` (one MX, SPF), DMARC `p=none` without `rua`, suppression list, IAM user for one From address, test send, production access request | S0 | 0.5-1 |
| S9 ADRs | Rewrites and acceptance (section 3) | parallel | 1-1.5 |
| S10 Runbooks, rebuild | Runbooks for deploy, rollback, rebuild, deletion failure, contract run; drill (below) | S2, S3 | 1-1.5 |
| **Total** (slice sum; with buffer 18-27, [roadmap](../03-roadmap.md)) | | | **15-23.5** |

**S2.** Compose sets memory limits and `stop_grace_period: 10s` and tags the image `ebay-sniper-server:<sha>`. One router, `Host(deals.intra-ai.de)` and the three paths; other paths get Traefik's default 404. A `buffering` middleware (`maxRequestBodyBytes: 65536`) returns 413 at the edge; Hono `bodyLimit` repeats it. No other router may match this host. `/healthz` returns `{"sha":"<commit>"}` from `GIT_SHA`, set at image build. Simon runs `ebay-deploy <sha>` over SSH (no timer, no host credential in GitHub). Owner decision 2026-10-20: a simple script until migrations exist (ADR 0029). It refuses a SHA not on `origin/main`, exports the tree from a public HTTPS clone into `releases/<sha>/`, builds and starts it with Compose, and rolls back to the running release if `/healthz` lacks the SHA after 60 s. With no previous release, a failure stops the new services. `infra/host/smoke` runs from outside afterwards. S1b adds the `.env` mode check, an explicit Postgres step and the migrate step. The failed-SHA list, image labels with the contract and pg-boss refusal, the disk floor and image pruning come in S4; healthchecks.io pings in S3 (ADR 0029). The worker has a heartbeat check.

**S10 drill.** On the shared host as project `/opt/ebay-sniper-drill` (`127.0.0.1:3141`, own volume and route file for `drill.intra-ai.de`, owner to confirm), removed afterwards. Env: only verification token, drill endpoint URL and `RUN_MODE=restore-drill`; no keyset, SES or healthchecks.io values, no eBay calls. Three times recorded: empty project to answering the challenge; DNS switch of the drill A record (TTL 300) until two public resolvers see it; certificate issuance. Production TTL is 300 too. Host loss is not measured.

Critical path: S3 keyset activation (time not stated by eBay), S5 gate 1a, three sampling days in S6. S4 does not wait.

## 6. Deletion endpoint (ADR 0013)

- `GET`: `SHA-256(challengeCode + verificationToken + endpoint)`, endpoint from `EBAY_DELETION_ENDPOINT_URL`, never `Host` or `X-Forwarded-*`.
- `POST`: 64 KB cap (S2); 204 before parsing. Then a bounded queue (1,000, overflow `dropped`), key cache and negative cache 1 h (LRU 10,000), one key fetch at a time, at most 10 an hour for unknown key IDs.
- Only verified notifications get an `app.deletion_event` row (no user identifiers); others go to hourly counters, or a log line if the database is down.
- SIGTERM: drain 10 s, count the rest `dropped_on_shutdown`. No rate limit; alert above 1,000 non-verified an hour.
- Probe: UptimeRobot keyword check every 5 min with `DELETION_PROBE_CODE`; `probe_seen` feeds `deletion-probe-seen`.
- eBay ([account deletion](https://developer.ebay.com/marketplace-account-deletion), read 2026-10-19): keyset activated after subscription; 200/201/202/204 accepted; marked down after 24 h unacknowledged; up to 1,500 a day; token 32-80 chars `[A-Za-z0-9_-]`.

Env file in `/opt/ebay-sniper`, root-owned, 0600, copy in the password manager: `EBAY_DELETION_ENDPOINT_URL` byte for byte the portal URL, verification token 64 chars, `DELETION_PROBE_CODE` 40 chars, passwords 32 random bytes.

## 7. Walking skeleton (S4)

1. `skeleton:ingest --source fixture` enqueues one job on `skeleton-ingest` (pg-boss `exclusive`); a second trigger is refused.
2. Fixtures: valid, missing shipping, malformed (counted, skipped), non-EUR.
3. `toListingCandidate(item, clock)`: integer cents, EUR only, landed = price + known shipping, unknown shipping flagged (never zero), `contentExpiresAt = min(fetchedAt + 6 h, itemEndDate)`.
4. One transaction: upsert `ebay_live.listing`, `listing_content`; insert `app.poll_run`.
5. Purge every 15 min (UTC): expired content; rows with `gone_at` (set after 48 h unconfirmed).
6. `GET /internal/listings`, server-rendered, "as of HH:MM CEST/CET". Not routed; `ssh -L` to 127.0.0.1:3140.

## 8. Contract run and query shapes (S5)

`docker compose run --rm worker contract:run --shapes <list>`, started by Simon after checking host load and disk. Each Browse call reserves via `reserve_ebay_call` (purpose `contract`); no start below 1,500 remaining; stop after 100 calls. Browse limit 5,000 a day except getItems ([call limits](https://developer.ebay.com/develop/api/buy/api_call_limits)). Expected: under 250 calls for shapes, ~16 per category for arrivals, 20-40 for Q7b. Metadata-only output to `/var/lib/ebay-sniper/contract/`, then `docs/ebay/contract-results.md`. Exit = yes: the shape must end `pass` or `fallback` (A17).

| ID | Shape | Pass | Fallback | Exit |
|---|---|---|---|---|
| Q1 | OR `q`, leaf category, `newlyListed`, `limit=200`, fixed price/Best Offer, DE delivery and location, price bounds, EUR, encoded `X-EBAY-C-ENDUSERCTX` | 200, no warnings, EUR, creation dates | Filter in code | yes |
| Q2 | Q1 with `itemLocationRegion:EUROPEAN_UNION` | No warning 12519/error 12517 | Germany only | yes |
| Q3 | `(rtx 3090, rtx3090)` vs each term and `rtx` | max(Ta,Tb) ≤ Tor ≤ 1.1(Ta+Tb), Tor ≤ 0.5 Trtx; if Ta+Tb < 20, retry in a larger category | One term per query | yes |
| Q4 | `sort=price` with bounds | No error 12034 | Tighter ceiling | yes |
| Q5 | Auctions ending within 4 h (ADR 0032) | No error 12034 | Phase 4 | no |
| Q6 | Unfiltered fair-value sample | Pages reach the end or documented cap; `total` recorded | Slice 2 | no |
| Q7 | `getItem` full | Field presence | Adjust enrichment | yes |
| Q7b | Seller type, `taxes[]` on 20 business items | Counts only | Text-based VAT | no |
| Q8 | `getItem` COMPACT | Price, availability | Full view | yes |
| Q9 | `getItem` on item group ID | Share; `ItemIsGroup` mapped | Exclude groups | yes |
| Q11-Q14 | `getRateLimits`; EBAY_DE leaf IDs; `getPublicKey`; error shapes | `remaining`, `reset`; `docs/ebay/categories.md`; key cached; 4xx `errorId` typed | Count locally; manual; `key_unavailable`; none | yes |

Gate 1a: one Q1 search returns EUR prices; request ID, time, status, `total`, currency in `gates.md`.

## 9. Acceptance criteria

Tests: test-first domain code (injected `Clock`), fast-check, MSW, integration on Postgres 18; contract runs on the host only. Other checks in brackets.

| # | Criterion |
|---|---|
| A1 | Challenge hash correct, also with spoofed `Host` |
| A2 | POST 204 within 1 s with key fetch down, before any fetch |
| A3 | POST over 64 KB: 413 at Traefik and Hono (smoke) |
| A4 | Database down: POST 204, log without user identifiers |
| A5 | Signed: one audit row; tampered: `bad_signature`; one fetch per key an hour (synthetic ECDSA) |
| A6 | Portal shows subscription and active keyset (screenshot) |
| A7 | Other paths 404 from outside, incl. `/internal/listings`; no other router matches the host (smoke, grep) |
| A8 | 3140 and Postgres closed from outside; no AAAA (`ss`, `nmap`, `dig`) |
| A9 | Probe alerts within 30 min of server stop (drill) |
| A10 | `/healthz` reports the SHA; workflows use only `GITHUB_TOKEN` |
| A11 | Failed `/healthz` rolls back to the previous release; a failed first deploy stops cleanly (deploy self-test). Migration, migrate-timeout and `.env` cases come with S1b; failed-SHA and failed-digest cases with S4 (ADR 0029) |
| A12 | Data survives Postgres recreate; concurrent migrate applies once (S1b); pending pg-boss migration blocks start (S4) |
| A13 | All timestamps `timestamptz`; 2026-10-25 CEST to CET |
| A14 | Valid item in EUR, Berlin time; others counted; one job for parallel triggers; live write, non-fixture source refused (tunnel) |
| A15 | Content purged within 15 min of expiry, row of `gone_at`; backstop 48 h, not 47 |
| A16 | Gate 1a evidence without listing content |
| A17 | Every Exit = yes shape `pass` or `fallback` (`pnpm exit:check`) |
| A18 | Warnings raise typed errors; long `q`, reserved filter characters rejected |
| A19 | Every Browse call reserved; no overrun; none after the 100th; no start below 1,500 |
| A20 | 429 not retried; 5xx/timeout once on GET; ten parallel 401s, one refresh |
| A21 | 1,000 POSTs, random key IDs: ≤10 fetches, 0 audit rows, counts sum to 1,000; queue capped on hung fetch |
| A22 | SIGTERM with 50 pending: all had 204, rest `dropped_on_shutdown` |
| A23 | No seller username in logs, jobs, `ebay_live`, output or git (sentinel, CI scan) |
| A24 | Supply report complete, counts only (Simon) |
| A25 | SES DKIM, MAIL FROM, DMARC verified; test mail passes all three; other From denied (`dig`, headers) |
| A26 | Drill: three times sum under 4 h; no production secret on it |
| A27 | Import breaking the ADR 0006 graph fails CI |

## 10. Risks

| Risk | Mitigation |
|---|---|
| Keyset activation slow or gate 1a fails | Simon decides stop or wait within 2 business days |
| Simon is sole reviewer, deployer and operator (Medium, High impact) | Agents draft, Simon signs; review rounds per PR recorded |
| Agent speed unmeasured | No speed-up assumed; recalibrate after week one |
| Scope creep into Phase 1 | Section 4; written decision needed |
| SES production access delayed; MAIL FROM detection up to 72 h | Sandbox with verified recipients covers Phase 0; S8 early |
| Shared host under load; contract runs add load | 204 before verification, memory limits, probe, 100-call cap, load and disk check first |
| Other services change Traefik or match this host | Own route file, A7, probe |
| Endpoint down 24 h | 5-min probe, rebuild under 4 h |

## 11. Exit gate

Simon signs the exit record in `gates.md` when: A1 to A27 pass (an A6 or A16 failure goes to the stop decision); the skeleton ran and purged in production; CI is green on `main`; the owner checklist is complete; D-20 and D-08 are recorded; ADRs are as in section 3; SES production access is requested; the [Phase 1](phase-1.md) calendar is recalibrated from actuals.

If weekly supply for core GPU segments is below the D-08 threshold, Simon reviews whether F1 beats eBay's saved-search emails and records stop or change of direction before Phase 1. On stop: retire the keyset in the portal before shutting the endpoint down.
