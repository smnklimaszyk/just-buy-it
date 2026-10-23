# Roadmap and estimates

Since v2, products are data; segment names below are history.

As of 2026-10-19. Owner: Simon Klimaszyk, building alone with Claude Code (D-01). Phase plans: `phases/`. ADRs: `../adr/README.md`.

## 1. Gates

Gates: **1a** (a live production EBAY_DE search returns EUR results) and **3** (a person always buys through eBay checkout; no bidding or buying automation, no scraping, no browser automation; ADR 0002). Licence review is the operator's responsibility; out of scope for this repo. Anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use.

Kept as good practice: the deletion endpoint, call limits and the call budget (ADR 0016), minimal retention of listing content (ADR 0014), no seller identifiers sent to Claude (ADR 0018), no resale of data.

## 2. Phase order

Thin vertical slices (ADR 0004); each phase ends in something running in production. Full criteria: `phases/phase-N.md`.

| Phase | Delivers | Starts when | Exit (summary) |
|---|---|---|---|
| 0 | Repo and CI, deploy to the shared Docker host (Compose, Traefik route), deletion endpoint and privacy page on `https://deals.intra-ai.de`, keyset active, skeleton, contract harness, gate 1a, supply counts, SES, founding ADRs | Now | Endpoint live, keyset active; gate 1a passed; every exit query shape pass or fallback; skeleton in production; SES `alerts.intra-ai.de` verified, production access requested; CI green |
| 1 | F1 max-price email alerts: feeds, classifier, budget, retention, sign-in, enrich-decide-send, dashboard, backups, measurement | Phase 0 exit | AC-01 to AC-29; 10-day production run (S9); 28-day review date set (D-07) |
| 2 | Fair value and tiers, recovery drill, pricing backup checks | Phase 1 go-live | 7 nights of snapshots and verified backups; supply report; restore within 4 h RTO; ADR 0017 accepted; five runbooks |
| 3 | Claude screening: 3a build and offline eval, 3b switch-on | Phase 2 exit | Held-out split meets targets; 7 days screened in production |
| 4 | Auctions with the watch maximum (ADR 0032), 21:00 digest | Phase 3 exit and D-34, D-36, D-41 to D-44 decided | AC 1 to 16; golden bid-limit cases (max EUR 500, shipping EUR 6.99: EUR 559.68, 588.01, 469.20, 493.01); 10 qualifying auctions or 3 weeks with no unexplained misses; daily calls at or below 80%; owner decides continue, digest-only or drop |
| 5 | Calibration (5A), one pilot sector (5B), ADR 0033 | Phase 3 exit (or F1 running); D-50 to D-54 decided; at least 30 labelled alerts per sector; runs beside Phase 4 | D-08 targets met; add-sector runbook run once |

Phase 1 go-live needs gate 1a and the Phase 1 build through S8; S9 is the 10-day production run after go-live. Phase 0 S7 is dropped.

### Does fair value join the first alert slice?

No. It stays in Phase 2, which now starts at Phase 1 go-live. Its 23 to 36 days assume the activation variant, now the default.

- It would push the first alert and the 28-day review back by about 5 to 7 reference weeks.
- It needs production data that only exists after go-live: 7 nights of snapshots, neff of at least 8 per segment, manual anchors (at least 10 sales) for the ask-to-sold ratio. On day one most segments would be Unrated.
- A refresh attempt plus retry may use up to 20 calls (phase-2 AC-16); refresh stays at or under 80% of every eBay window. Phase 1 measures real use first.
- The 28-day review needs a clean max-price baseline, so tiers are recorded in shadow and shown after the review snapshot (`pricing.display`).

May move earlier: the pure fv-1 code (P2-4, test-first, no I/O) as a separate agent stream during Phase 1, on files disjoint from Phase 1's.

## 3. Estimates

Reference engineer-days: one engineer who knows the stack, without agents, buffer included. Speed with Claude Code is **unmeasured**; no factor is applied.

| Phase | Engineer-days | Reference calendar, one person | Notes |
|---|---|---|---|
| 0 | 18 to 27 | about 4 to 5.5 weeks | S7 (1.5 to 2.5) removed. S2 on existing Traefik likely smaller |
| 1 | 41 to 59 | 10 to 14 weeks | Includes 30% one-person contingency and the 10-day run |
| 2 | 23 to 36 | 5.5 to 8 weeks | |
| 3 | 30 to 45.5 | 6 to 9 weeks (3a), then 1.5 (3b) | Plus Simon's case building |
| 4 | 19.5 to 25 | 6 to 8 weeks | Digest-only path 14 to 17.5 |
| **0 to 4** | **131.5 to 192.5** (about 26 to 38.5 weeks) | | Earlier plan: 8 to 13 weeks |
| 5 | 23 to 34 | 7 to 10 weeks at about 70%, overlapping | Conditional extras 1 to 12.5 |

Buyer profile (D-04) included: Phase 1 1.5 to 2.5, Phase 3 0.5, Phase 4 0.5 to 1.

**First alert:** Phase 0 plus Phase 1 build, about 13.5 to 19.5 reference weeks without agents, less with Claude Code (unmeasured).

**Recalibration.** Each Phase 0 slice records start date, merge date, Simon's hours and review rounds. At Phase 0 exit the ratio of actual to reference days replaces the reference for phases 1 to 5, with ratio and date stated. Checked again at Phase 1 exit.

## 4. Critical path

```
Phase 0: S1 repo/CI -> S2 deploy -> S3 deletion endpoint -> [keyset activation]
         -> S5 contract harness, gate 1a -> S6 sampling (3 to 5 days) -> exit
Phase 1: S1 domain -> S4 feeds -> S5 enrich/decide/send -> S6/S7/S8 in parallel
         -> go-live -> S9 production run (10 days) -> exit
Then:    28-day review after the first alert; Phase 2 build overlaps it
```

Off the path: SES (S8), ADR acceptance (S9), runbooks (S10). Simon's review of every pull request is serial; concurrent agent sessions must be file-disjoint, one session at a time owns migrations.

## 5. External waits and endpoint duties

| Item | Documented figure | Blocks |
|---|---|---|
| Keyset activation after the deletion subscription is saved | Not stated | Phase 0 S5, gate 1a, all production calls |
| Deletion endpoint compliance | URL marked down after 24 h of unacknowledged notifications, then 30 days to fix before non-compliance; up to 1,500 notifications a day | Keyset stays active only while met |
| SES MAIL FROM detection (`mail.alerts.intra-ai.de`) | Up to 72 hours | Phase 0 S8 |
| SES production access | "Initial response within 96 hours" | Unverified recipients only; sandbox (200 per 24 h, 1 per second) is fine while Simon is the only recipient |
| Application Growth Check | Not published; filing steps in `guides/ebay-access.md` (D-57) | More feeds or sectors beyond 5,000 Browse calls a day |
| Measurement windows | P1 10 days; P2 7 nights; P3 7 days; P4 measurement week plus 2 to 3 weeks; P5 4 weeks of labels, 14 to 21 days per pilot stage | Each phase exit |

Sources (read 2026-10-19): https://developer.ebay.com/marketplace-account-deletion, https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html, https://docs.aws.amazon.com/ses/latest/dg/mail-from.html.

## 6. Owner time (not in engineer-days)

| Item | Time | Phase |
|---|---|---|
| Solo GitHub Free setup, deploy to the shared host, owner checklist (input tax, legal form, business eBay account) | 3 to 5 days | 0 |
| Review of every pull request (CI green, fresh-context review, go before production deploys) | Unmeasured; measured in Phase 0 | all |
| Classifier review, first 48 production hours | Two sessions (AC-29) | 1 |
| Alert feedback labels (D-50) | Within 7 days of each alert | 1 on |
| Manual sold anchors | 1 to 2 h per segment, within 30 days | 2, 5 |
| Claude compliance pack (DPA, GDPR assessments, processing record) | 2 to 4 days | 3 |
| Evaluation cases: 3a (30 tuning, 24 + 24 held-out); full 110 | 56 to 91 h; 79 to 129 h total | 3 to 5 |
| Template corpus, 30 descriptions | 1 to 1.5 days | 3 |
| Shadow and blocked-item labels | 5 to 10 min a day per item, 4 to 6 weeks | 3 to 5 |
| Auction recall reference | About 1 h setup, then 3 manual samples a week if saved-search emails ignore the auction filter | 4 |
| Review sessions (28-day, calibration, pilot promotion) | 3 to 4 h each | 1, 5 |

## 7. Risks to the schedule

- **Shared host.** The app runs on a shared Docker host behind Traefik. Noisy neighbours can delay jobs, sweeps and deletion acknowledgements (24 h limit above); the endpoint needs the external probe. Backups use the host's backup practice plus our own dump without listing content; free disk space is a risk for Phase 2 snapshots and backups.
- **Keyset or account loss** ends production polling. Fallback: stop (F2) or rebuild on another data source; no plan exists for that.
- **GitHub Free.** Phase 2 `backup-verify` and Phase 3 `eval` assumed environment secrets, which private repos on GitHub Free lack. Decide in Phase 2 where those keys live.
- **The 28-day review** decides continue, cut or stop (F2) against 3 to 5 agreed numbers (D-08). It comes before most of the cost of phases 2 to 4 and is the main control on the larger total.
