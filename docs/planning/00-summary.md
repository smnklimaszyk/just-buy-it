# eBay Sniping Tool: summary

Status 2026-10-19. Owner: Simon Klimaszyk (Intra AI). Decision IDs refer to [02-decisions.md](02-decisions.md), ADRs to [../adr/README.md](../adr/README.md). Every ADR is "proposed" until Simon merges it.

## 1. Verdict

The engineering design holds: a modular monolith on Postgres with server and worker processes, test-first domain code, retention designed in. The plan's 8 to 13 engineer-weeks for phases 0 to 4 is about a third of the real work (26 to 38.5, section 4). See [01-review.md](01-review.md). Anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use.

## 2. Main changes to the plan

1. **Thin vertical slices.** Phase 1 is max-price email alerts (F1), so the first alert comes at the end of Phase 1, not Phase 3. Price check dropped (D-47), market check out of v1 (D-23), four dashboard screens (D-24).
2. **Fair-value method change.** Weighted median as reference, interval width as a gate only, one ordered tier function with a property test (ADR 0017).
3. **Retention rewritten.** Three data classes in three schemas; listing rows deleted once gone; backups exclude `ebay_live`, age-encrypted, kept at most 17 days (ADR 0014, 0025).
4. **Deletion endpoint redesign.** Every POST up to 64 KB gets 204 before parsing, verification later in a bounded queue, external probe every 5 minutes (ADR 0013, 0030).
5. **One shared eBay call counter** in Postgres for all processes, capped at 80% of the daily pool (ADR 0007, 0016).
6. **Claude screening safeguards.** Typed evidence, injection checks and verdict in code, failures at least CAUTION, held-out evaluation as regression gate, contact data masked (ADR 0018 to 0020, 0026, 0028).
7. **Existing shared Docker host** behind Traefik, not a dedicated VPS with Caddy (section 3).
8. **Estimates per deliverable** with buffers; owner time and waits separate; recalibrated after Phase 0 ([03-roadmap.md](03-roadmap.md)).

## 3. Owner decisions

All decided by Simon Klimaszyk on 2026-10-19.

| ID | Decision |
|---|---|
| D-01 | Simon is owner and compliance owner, the only person, building with Claude Code. Estimates are for one person, unmeasured, recalibrated after Phase 0 |
| D-02 | Intra AI holds all accounts; Simon is account holder and billing owner |
| D-03 | Domain `intra-ai.de`. App, dashboard, `/ebay/account-deletion` and `/privacy` on `https://deals.intra-ai.de` (A record exists). SES identity `alerts.intra-ai.de`, MAIL FROM `mail.alerts.intra-ai.de` |
| D-04 | Intra AI buys as a company by default. `buyer_profile` (`company` \| `private`, default `company`) per watch, private what-if in the dashboard, never stored ([guides/company-vs-private.md](guides/company-vs-private.md)) |
| D-05/D-06 | Licence review is the operator's responsibility; out of scope for this repo |
| D-07 | F1 max-price alerts first; F1 is the fallback, F2 is stop. 28 days after the first alert, continue, cut or stop is decided against 3 to 5 agreed numbers (D-08); stop if F1 is not clearly better than eBay's saved-search emails (ADR 0004) |
| D-37 (updated) | Repository under Simon's personal GitHub account, GitHub Free; a ruleset on `main` requires a pull request with green CI (2026-10-20). By convention: a fresh-context review before merge; Simon's go before each production deploy ([ADR 0029](../adr/0029-ci-cd-and-deploy.md)) |
| D-48 | Ops alerts to Simon's mailbox. DMARC `p=none`, no `rua` |
| Hosting | Existing Intra AI server (below), replaces the dedicated VPS in ADR 0012 |

**Gates** (ADR 0003): gate 1a, a live production `EBAY_DE` search returns EUR results (technical check). Gate 3, a person always buys through eBay checkout; no bidding or buying automation, no scraping, no browser automation (ADR 0002).

**Kept as good practice:** the deletion endpoint (needed to activate the keyset), call limits and budget, minimal retention of listing content, no seller identifiers sent to Claude, no resale of data.

**Hosting.** Shared Docker host, Ubuntu 24.04, Docker 29, Compose v5. Compose project in `/opt/ebay-sniper` with its own Postgres container. Edge is the server's Traefik v3.6 (host network, file provider `/opt/traefik/dynamic`, resolver `le`, middlewares `redirect-to-https` and `hsts-headers`); route file `/opt/traefik/dynamic/ebay-sniper.yml`. Containers bind to 127.0.0.1 only (server on 127.0.0.1:3140). Simon deploys with `ebay-deploy <sha>` over SSH on the host (ADR 0029); GitHub holds no host credential. ADR 0012 is rewritten for the shared host; the 4-hour RTO is as defined there (clean rebuild, restore, DNS switch and certificate inside the 4 hours).

Risks:
- Shared host; neighbours can delay jobs.
- Deletion endpoint: eBay marks the URL down after 24 hours of unacknowledged notifications, then gives 30 days to fix before non-compliance; volume can reach 1,500 notifications a day. The external probe covers this.
- Call budget: default pool 5,000 calls a day, so the 80% cap is 4,000. More calls only through the Application Growth Check (D-57).
- Backups follow the server's `/opt/backups` practice plus our own dump without listing content.

## 4. Phase overview

Engineer-days with buffers, one engineer without agents, no speed-up assumed, owner time and waits excluded. Figures from the [roadmap](03-roadmap.md); the Phase 0 recalibration replaces all figures.

| Phase | Goal | Effort (eng-days) | One-engineer calendar | Plan | Exit gate (short) |
|---|---|---|---|---|---|
| 0. Gates and walking skeleton | Prove the path to production | 18 to 27 | about 4 to 5.5 weeks | 1 to 2 weeks | Deletion endpoint, `/privacy`, `/healthz` live; keyset active; skeleton in production; gate 1a; every exit query shape pass or fallback; supply report; SES verified; founding ADRs accepted; CI green |
| 1. Max-price alerts (F1) | Smallest product that can lead to a purchase | 41 to 59 (incl. 30% one-person contingency) | 10 to 14 weeks | 1 to 2 weeks | AC-01 to AC-29; `buyer_profile` per watch; one seeded user (Simon); 10-day production run; fair-value and screening flags off; call, delay and supply figures recorded; 28-day review date set |
| 2. Fair value and tiers, recovery | Show how cheap a listing is; recover within 4-hour RTO | 23 to 36 | 5.5 to 8 weeks | 2 to 3 weeks | 7 nights of verified backups; restore drill at 4 hours or less; ADR 0017 accepted; five runbooks |
| 3. Claude screening (3a build and evaluate, 3b switch-on) | Screen every alert candidate | 30 to 45.5 | 6 to 9 weeks for 3a, then 1.5 for 3b | 3 to 4 weeks | Held-out 24 scam + 24 legitimate cases meet targets; 7 days in production |
| 4. Auctions with the watch maximum | Alert about 60 min before end, 21:00 digest | 19.5 to 25 (digest only 14 to 17.5) | 6 to 8 weeks | 1 to 2 weeks | Four golden bid-limit cases pass; 10 qualifying auctions or 3 weeks with no unexplained misses; calls at or below 80% |
| 5. Calibrate and extend | Thresholds checked against labels; new sector as routine | 23 to 34 core | 7 to 10 weeks at about 70% | not estimated | D-08 precision and alert count met; ADR 0033 accepted; add-sector runbook run on a pilot |
| **0 to 4** | | **131.5 to 192.5 (about 26 to 38.5 eng-weeks)** | **about 33 to 46.5 weeks** | **8 to 13 weeks** | |

Owner time on top: 3 to 5 days in Phase 0, 7 to 12 person-days of evaluation cases for 3a, every PR review. The first alert waits on keyset activation, gate 1a, SES production access ("initial response within 96 hours") and the build.

## 5. Status and next steps

**Done:** eBay developer account; application with sandbox and production keysets; DNS A record for `deals.intra-ai.de`.

**In progress:** Phase 0 S3, the deletion endpoint on `intra-ai`; the keyset stays disabled until the deletion subscription is saved.

**Next:**

1. Deploy endpoint and `/privacy` behind Traefik; confirm HTTPS and 204 on a test POST.
2. Save the deletion subscription in the eBay developer portal; confirm the keyset is active ([guides/ebay-access.md](guides/ebay-access.md)).
3. External probe (every 5 minutes) and ops mail to Simon.
4. Gate 1a: one live production `EBAY_DE` search returning EUR results.
5. SES: verify `alerts.intra-ai.de` and MAIL FROM (detection up to 72 hours); request production access.
6. Rest of Phase 0 ([phases/phase-0.md](phases/phase-0.md)).
7. At Phase 0 exit, record actual days per slice and recalibrate.
