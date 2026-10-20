# ADR-0011: Environments, accounts and secrets

**Date**: 2026-10-19
**Status**: proposed (D-02, D-03, D-37 and hosting are decided)
**Related**: ADR 0006, 0007, 0012, 0013, 0016, 0019, 0022, 0024, 0025, 0026, 0028; D-02, D-03, D-17, D-35, D-37, D-48

## Context

- One eBay keyset, 5,000 Browse calls a day ([eBay](https://developer.ebay.com/develop/apis/api-call-limits)); any polling environment spends that pool. Planned: 3,256 a day for five slice-1 feeds before the alert path, cap 4,000 (80%, ADR 0016).
- The production keyset stays disabled until `https://deals.intra-ai.de/ebay/account-deletion` answers over HTTPS with a 32 to 80 character `[A-Za-z0-9_-]` token ([eBay](https://developer.ebay.com/marketplace-account-deletion)).
- Anthropic: monthly per-workspace spend limits, none on the Default Workspace, not readable by API; service-account keys outlive their creator ([docs](https://platform.claude.com/docs/en/manage-claude/workspaces)).
- GitHub Free (D-37): no environment secrets or required reviewers on private repos.
- Shared host `intra-ai` (ADR 0012); one person, about 20 secrets.

## Decision

Four environments (below) plus a restore-drill mode; no staging host. Intra AI holds every account, each with 2FA; Simon is holder and billing owner; the repository is on his personal GitHub. Ops alerts and the eBay portal alert address go to Simon's mailbox; DMARC reporting is deferred (D-48). Production secrets live in `/opt/ebay-sniper/.env` (`root:root 600`, read by Compose), copied to the password manager. `docs/runbooks/secrets-register.yaml` records owner, location, scope and rotation for every secret and env var.

| | Local | CI | Contract run | Production |
|---|---|---|---|---|
| eBay | fixtures (D-17) | fixtures | production keyset | production keyset (no sandbox) |
| Claude | personal key, `dev` workspace | none | none | service account, `prod` |
| Email | log notifier; SES dev user to the simulator only | log notifier | none | SES, From on `alerts.intra-ai.de` |
| Secrets | local `.env`, dev values | `GITHUB_TOKEN` | production `.env` | `/opt/ebay-sniper/.env` |

- **Contract runs**: a one-off container from the deployed image, started by Simon over SSH; at most 100 calls a run before polling starts, then at most 50 contract calls a day (ADR 0016). Calls reserve through the shared counter as `contract` (ADR 0007). It reads `getRateLimits` first, refuses below 1,500 remaining before polling starts, and later if its plan cuts into what production needs before the reset.
- **Evals**: no `push` or `pull_request` trigger, at most $60 a run. On Free the `evals` key is a repository secret only `evals.yml` may use; the `eval` limit caps a leak.
- **Backup verify**: `backup-verify.yml` (phase 2) is the only other workflow allowed a secret, the list-only verify key.
- **Deletion probe**: UptimeRobot checks the endpoint, marking requests with `DELETION_PROBE_CODE` from the `.env` (ADR 0030).
- **Restore drill**: `RUN_MODE=restore-drill` keeps the worker off and the notifier refusing; no eBay, Anthropic, SES or healthchecks.io values.
- **Deploy**: on Simon's go, `ebay-deploy <sha>` on the host builds the image from a clone of the public repo over HTTPS (ADR 0029); GHCR pull later; GitHub holds no host credential.
- **Anthropic limits**: `prod` $360 a month (31 x ADR 0028 lanes of $10 + $1.50), alerts at 50% and 80%; `eval` $50, then $190, then $260, +$40 in a sweep month; `dev` $20. No key in the Default or Claude Code workspace.

Tables and `openssl` commands: [environments and secrets](../planning/environments-and-secrets.md).

## Alternatives considered

Staging host (same eBay pool, second deletion endpoint); secrets manager or SOPS (too much for one host); personal keys (archived on leaving); production secrets in CI (workflow edits read them); evals on every pull request ($18 to $45 a push, ADR 0026).

## Consequences

- **Positive**: only production, contract runs and capped evals spend quota or budget.
- **Negative**: manual rotation; `.env` and password manager can drift; reads are not logged; no live eBay data locally; review before merge is a convention; spend limits checked by hand.
- **Risks**: losing the item-key HMAC key or age identity (password manager plus offline copy, tested by the drill). A leaked SES key sends spam (From-address condition). Put-only backup key unverified (ADR 0025). Better Auth 1.7 `BETTER_AUTH_SECRETS` support unverified (fallback `BETTER_AUTH_SECRET`; rotation signs everyone out). Without the probe a dead endpoint goes unnoticed and eBay may disable the keyset. The shared host can be busy, so other services can delay jobs; backups use the host's own backups plus our own dump without listing content.

## How we check it

- CI fails if a workflow other than `evals.yml` or `backup-verify.yml` uses a secret besides `GITHUB_TOKEN`, or if `evals.yml` has a trigger besides `workflow_dispatch` and `schedule`.
- Env schema: production needs each required secret; `restore-drill` refuses eBay credentials and the notifier throws.
- A test keeps the register equal to each app's env schema (ADR 0006). Deploy stops unless the `.env` is `root:root 600`.
- The worker stops screening if `anthropic-workspace-id` differs from `ANTHROPIC_WORKSPACE_ID` (ADR 0019).
- Monthly, with a short-lived Admin API key, `scripts/anthropic-key-audit.ts` fails on any active key in the Default or Claude Code workspace; Simon reads spend limits in the Console.
- SES policies (`infra/aws/iam/`) are unit-tested and run through `aws iam simulate-custom-policy` quarterly.
- Before the first backup: the put key uploads but cannot read, list or delete.
- Better Auth: a `1:old` session is accepted after `2:new,1:old`.
- A contract run's count equals its `contract` rows in `api_usage_hourly`; a unit test covers late-window refusal.

## Revisit when

Second host, keyset, quota or person; GitHub plan change; failed backup key or Better Auth check; spend limits in the API; production traces to Langfuse (D-35).
