# eBay Sniping Tool: docs

## Status (2026-10-19)

- Phase 0, slice S3: deploying the eBay account deletion endpoint to `https://deals.intra-ai.de/ebay/account-deletion`.
- eBay app with sandbox and production keys exists. Production keys stay disabled until the deletion subscription is saved.
- Anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use. Kept checks: gate 1a (a live EBAY_DE search returns EUR prices); gate 3 (a person buys through eBay checkout; no bid or buy automation, scraping or browser automation).
- Kept controls: eBay call limits and call budget, minimal listing retention, no seller IDs sent to Claude, no data resale.
- Hosting: a shared Docker host behind Traefik, `/opt/ebay-sniper`. Jobs can lag on a shared host; deletion endpoint needs an external probe. Backups: `/opt/backups` plus our dump without listing content.
- Repo: Simon's GitHub Free account, no branch protection. CI and a fresh-context Claude Code review before merge; Simon's go before production deploys.
- Owner and sole builder: Simon Klimaszyk, with Claude Code.

## Key decisions

- D-07: F1 max-price alerts first; 28-day continue-or-stop review.
- D-04: company buys by default; `buyer_profile` (company or private) per watch; private what-if in the dashboard.
- D-03: privacy page on deals.intra-ai.de; SES `alerts.intra-ai.de`, MAIL FROM `mail.alerts.intra-ai.de`.
- D-48: ops alerts to Simon's mailbox; DMARC `p=none`, no `rua`.

## Reading order

| File | Covers |
|---|---|
| [Summary](planning/00-summary.md) | Overview, decisions, next steps |
| [Decisions](planning/02-decisions.md) | All D-xx decisions |
| [Roadmap](planning/03-roadmap.md) | Phases 0-5, estimates, critical path |
| [Phase 0](planning/phases/phase-0.md) | Deletion endpoint, hosting, skeleton, SES |
| [Environments](planning/environments-and-secrets.md) | Accounts, secrets, env vars |
| [eBay access](planning/guides/ebay-access.md) | Deletion subscription, gate 1a, call limits |
| Phases [1](planning/phases/phase-1.md) [2](planning/phases/phase-2.md) [3](planning/phases/phase-3.md) [4](planning/phases/phase-4.md) [5](planning/phases/phase-5.md) | Alerts, fair value, Claude screening, auctions, calibration |
| [Company vs private](planning/guides/company-vs-private.md) | `buyer_profile`, law, VAT |
| [Review](planning/01-review.md) | Review of the first plan |
| [ADRs](adr/README.md) | ADR index 0001-0033 |

Key ADRs: [0003](adr/0003-ebay-licence-gates-and-evidence-standard.md), [0012](adr/0012-hosting-and-deployment.md), [0013](adr/0013-ebay-user-data-deletion-and-identifiers.md), [0029](adr/0029-ci-cd-and-deploy.md).

## Files created later

These paths are referenced in the docs but are outputs that do not exist yet.

| Path | Created in |
|---|---|
| `runbooks/secrets-register.yaml` | Phase 0 S1 (ADR 0011) |
| `compliance/service-providers.md` | Phase 0, as a stub (ADR 0014) |
| `ebay/contract-results.md`, `ebay/categories.md` | Phase 0 S5 |
| `ebay/supply-2026-10.md` | Phase 0 S6 |
| `runbooks/*.md` | Phase 0 S10 onward, per phase |
| `reports/phase-2-supply.md` | Phase 2 |
| `compliance/growth-check.md` | Only if Simon files the Growth Check (D-57) |
| `calibration/` | Phase 5A |
| `sectors/` | Phase 5B |
