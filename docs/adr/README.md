# Architecture decision records

Index required by ADR 0001; D-xx: [02-decisions](../planning/02-decisions.md). All were written 2026-10-19 and are **proposed**; none is accepted until Simon merges it (Lifecycle below). A record is proposed before its work starts and accepted by "Needed by". Phase 0 starts Mon 19 Oct 2026. On day 1 (S0), before the ADR 0001 CI check is on, Simon turns each "Needed by" into an ISO date, recalibrated from Phase 0 actuals.

| ADR | Title | Status | Notes | Needed by |
|---|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record decisions as ADRs | proposed | Amended: solo approval | Phase 0 S1 |
| [0002](0002-human-completes-every-purchase.md) | A person makes every purchase | proposed | | Phase 0 S5 |
| [0003](0003-ebay-licence-gates-and-evidence-standard.md) | eBay terms: gate 1a only | proposed | Licence review is the operator's responsibility; out of scope for this repo | Phase 0 S5 |
| [0004](0004-product-modes-and-slice-order.md) | Modes, slice order, 28-day review | proposed | | Phase 0 exit |
| [0005](0005-core-stack-versions-and-schema-ownership.md) | Versions, one migrate step | proposed | | Phase 0 S1 |
| [0006](0006-monorepo-package-boundaries-and-ports.md) | Package boundaries and ports | proposed | | Phase 0 S1 |
| [0007](0007-process-topology-and-outbound-calls.md) | Two processes, outbound calls | proposed | | Phase 0 S1b |
| [0008](0008-time-and-clock-handling.md) | Time and clock | proposed | | Phase 0 S1b |
| [0009](0009-configuration-and-decision-versioning.md) | Config and decision versions | proposed | | Phase 1 entry |
| [0010](0010-sector-and-marketplace-extensibility.md) | New sectors and marketplaces | proposed | | Phase 1 entry |
| [0011](0011-environments-accounts-and-secrets.md) | Environments, accounts, secrets | proposed | | Phase 0 S1 |
| [0012](0012-hosting-and-deployment.md) | Shared host behind Traefik | proposed | Amended: shared host at `deals.intra-ai.de`; deploys only by Simon over SSH (ADR 0029) | Phase 0 S2 |
| [0013](0013-ebay-user-data-deletion-and-identifiers.md) | Deletion endpoint, item keys | proposed | `https://deals.intra-ai.de/ebay/account-deletion` | Phase 0 S3 |
| [0014](0014-data-retention-classes-and-backups.md) | Data classes and retention | proposed | Lifetimes wait on D-11 (retention) | Phase 1 entry |
| [0015](0015-job-execution-idempotency-and-delivery.md) | Jobs, call claims, alert delivery | proposed | | Phase 0 S4 |
| [0016](0016-ebay-ingestion-feeds-and-call-budget.md) | Feeds and eBay call budget | proposed | | Phase 0 exit or D-20 supply test |
| [0017](0017-fair-value-and-tier-assignment.md) | Fair value and tiers | proposed | Waits on reference price, sold ratio, thresholds | Phase 2 P2-4 |
| [0018](0018-claude-data-flow-and-residency.md) | Claude data flow | proposed | Waits on GDPR work | Phase 3b switch-on |
| [0019](0019-listing-screening-pipeline.md) | Screening pipeline | proposed | Waits on per-listing failure rule | Phase 3a |
| [0020](0020-risk-verdict-and-evidence-verification.md) | Risk verdict | proposed | | Phase 3a |
| [0021](0021-authentication-email-one-time-codes.md) | Email one-time-code login | proposed | Dashboard on `deals.intra-ai.de` | Phase 1 S3 |
| [0022](0022-alert-email-through-amazon-ses.md) | Email through Amazon SES | proposed | Identity `alerts.intra-ai.de`, MAIL FROM `mail.alerts.intra-ai.de`; DMARC `p=none`, no `rua` (D-48) | Phase 0 S8 |
| [0023](0023-testing-and-evaluation-strategy.md) | Testing strategy | proposed | | Phase 0 S1b |
| [0024](0024-observability.md) | Logs, metrics, Ops page | proposed | Ops alerts to Simon's mailbox | Phase 1 entry |
| [0025](0025-backups-and-restore-drill.md) | Backups, restore drill | proposed | Dump lifetime follows D-11 | Phase 1 entry |
| [0026](0026-llm-evaluation-strategy.md) | LLM screener evaluation | proposed | Waits on PASS-rate target | Phase 3 build |
| [0027](0027-buyer-status-and-seller-returns-rules.md) | Buyer profile, returns rules | proposed | `buyer_profile` company or private per watch, default company (D-04); company Medium/Medium provisional until § 307 BGB check | Phase 3a |
| [0028](0028-screening-budget-and-model-selection.md) | Screening budget, model choice | proposed | Waits on review cadence, PASS rate | Phase 3 model sweep |
| [0029](0029-ci-cd-and-deploy.md) | CI/CD, deploy, rollback | proposed | Split from 0012 | Phase 0 S2 |
| [0030](0030-heartbeats-and-external-probe.md) | Heartbeats, endpoint probe | proposed | Split from 0024 | Phase 0 S3 |
| [0031](0031-deep-evaluation-revisions.md) | Deep-evaluation revisions | proposed | Changes the `deep` row of 0015 part B | Phase 3 slice 3.7 |
| [0032](0032-auction-path.md) | Auction path | proposed | Waits on auction rules (D-36, D-41 to D-44) | Phase 4 S2a merge |
| [0033](0033-calibration-and-config-change-process.md) | Calibration and config changes | proposed | Waits on metrics, labels, approver | First Phase 5 calibration |
| 0034 | Fair-value method v2 | — | Reserved | Only if 5A.8 changes the method |

Plan decisions 001 to 016 map to 0002, 0006/0007, 0017, 0018/0019, 0016, 0013, 0021, 0022, 0005, 0019/0004, 0019/0028, 0032, 0015, 0020, 0014/0025, 0010. The rest have none.

## Lifecycle

Simon accepts one by merging its pull request after green CI and a fresh-context Claude Code review; no second approver, no CODEOWNERS (D-37). Accepted records are only superseded; numbers are never reused. New record: copy [template.md](template.md) to `NNNN-slug.md`, add its row here in the same pull request.
