# Environments, accounts and secrets

Status 2026-10-19. Owner: Simon Klimaszyk (D-01). From [ADR 0011](../adr/0011-environments-accounts-and-secrets.md); hosting per [phase 0](phases/phase-0.md). Where this page and [02-decisions.md](02-decisions.md) differ, the decisions win.

**Rule: secrets are never pasted into a chat (including Claude Code sessions), an issue, a PR, a log or a commit.** Generate them on the machine that uses them, copy them into the password manager (PM below) and refer to them by variable name only.

## 1. Environments

| | Local | CI | Contract run | Production |
|---|---|---|---|---|
| Runs on | Simon's Mac, Compose | GitHub Actions, `pull_request` and `push` | `docker compose run --rm worker contract:run`, over SSH on Simon's go | Host `intra-ai`, Compose project `/opt/ebay-sniper` |
| Postgres | `postgres:18` container | Postgres 18 service | Production database, call counter only | `postgres:18` in the project, not published |
| eBay | Fixtures; deletion route with a test token | Fixtures | Production keyset, rules below | Production keyset |
| Claude | Personal key in `dev`, opt-in tests | None | None | Service-account key in `prod` (Phase 3) |
| Email | Log; optional SES dev user, simulator only | Log | Sends nothing | SES `ses-sender-prod` (Phase 1) |

- No staging host; CI has only `GITHUB_TOKEN`. Edge: the host's Traefik (`/opt/traefik/dynamic/ebay-sniper.yml`, resolver `le`); containers bind to 127.0.0.1 (server `:3140`).
- **Deploy** only on Simon's explicit go (D-37): `ebay-deploy <sha>` over SSH ([ADR 0029](../adr/0029-ci-cd-and-deploy.md)). No deploy user; GitHub holds no host credential.
- **Contract runs** ([ADR 0016](../adr/0016-ebay-ingestion-feeds-and-call-budget.md)):
  - Before production polling starts: at most 100 calls per run; refuses to start below 1,500 remaining calls (`getRateLimits`).
  - After: at most the contract line of 50 a day; starts only if remaining minus planned calls covers what production needs before the reset (polls plus alert reserve), using the governor's budget function.
  - Builds its call plan first and refuses a plan over the cap (split larger sets with `--shapes`). Start it just after the reset time.
  - Writes metadata only (calls, remaining, reset time). Every call is counted in the shared counter with purpose `contract`.
  - Follows every deploy that changes the eBay client.
- **Evals** (Phase 3): `evals.yml` runs only on `workflow_dispatch` and a weekly `schedule` on `main`, never on push or pull request; $60 cap per run. `prod` limit = 31 x the daily alert and audit lanes ([ADR 0028](../adr/0028-screening-budget-and-model-selection.md)), $360 at $10 + $1.50; an upgrade lane raises it first. Spend alerts at 50% and 80%.
- **GitHub Free**: no environment secrets, so repository secrets, used only by `backup-verify.yml` (verify key) and `evals.yml` (eval, Langfuse keys); decided in Phase 2 (see [phase 2](phases/phase-2.md) P2-1 and [phase 3](phases/phase-3.md)).
- **Restore drill** (monthly from Phase 2, 4-hour target, [ADR 0025](../adr/0025-backups-and-restore-drill.md)): `RUN_MODE=restore-drill`, worker and notifier off, no eBay, SES or healthchecks.io values, never the portal URL. Keys never touch disk: read key in a shell variable, age identity on tmpfs (`/dev/shm`, 0600). Simon pings `restore-drill` (35-day period).

### Production or sandbox

**Production.** `https://deals.intra-ai.de/ebay/account-deletion` is saved on the production keyset; gate 1a needs a live production `EBAY_DE` search returning EUR ([guides/ebay-access.md](guides/ebay-access.md)). The app never uses the sandbox keyset (fixtures, D-17); its keys stay in the PM.

## 2. Accounts

Intra AI holds every account; Simon is holder, only admin and billing owner (D-02). 2FA everywhere, recovery codes in the PM, mail to Simon (D-48).

| Account | Notes | Needed from |
|---|---|---|
| Registrar and DNS, `intra-ai.de` | A record `deals.intra-ai.de` exists (TTL 300, no AAAA) | Done |
| eBay Developer Program | Production keyset disabled until the deletion subscription is saved | Done |
| Intra AI business eBay.de account | Buys (D-04) | Phase 1 |
| Server `intra-ai` | Shared Docker host behind Traefik | Done |
| GitHub, Simon's personal account, Free | Public repository | Phase 0 S1 |
| AWS (SES `eu-central-1`) | Root user for recovery only | Phase 0 S8 |
| Anthropic | Workspace limits: `prod` $360/month, `eval` $50 (then $190, $260, +$40 in a sweep month), `dev` $20 | Workspaces Phase 0, keys Phase 3 |
| healthchecks.io, UptimeRobot | Alerts to Simon | Phase 0 S3 |
| Langfuse Cloud EU | Eval project only (D-35) | Phase 3 |

**DNS** ([ADR 0022](../adr/0022-alert-email-through-amazon-ses.md)): three Easy DKIM CNAMEs `<token>._domainkey.alerts.intra-ai.de` (values from SES); on `mail.alerts.intra-ai.de` exactly one MX `10 feedback-smtp.eu-central-1.amazonses.com` and TXT `"v=spf1 include:amazonses.com ~all"`; `_dmarc.alerts.intra-ai.de` TXT `v=DMARC1; p=none`, no `rua` (D-48). A CAA record is optional; if added it must allow Let's Encrypt.

## 3. Secrets

Production: `/opt/ebay-sniper/.env`, `root:root 600`, every value also in the PM. Local `.env` files: dev values, git-ignored; `.env.example` has placeholders.

| Secret | Used by | Lives in | Create / scope | Rotate |
|---|---|---|---|---|
| eBay App ID, Cert ID (prod) | server, worker, contract | `.env`, PM | Application Keys page | Reset Cert ID on leak or holder change |
| eBay Dev ID, sandbox keyset | nobody / manual tests | PM | With the keyset | On leak |
| Deletion verification token | server | `.env`, PM | 64 chars | `.env`, restart, then portal |
| `DELETION_PROBE_CODE` | server, UptimeRobot; checked by the deploy | `.env`, PM, monitor URL | 40 chars | On leak, with the monitor URL |
| `POSTGRES_PASSWORD` | db bootstrap; migrate (role `ebay_sniper`) | `.env`, PM | `openssl rand -hex 32` (hex, because Compose embeds it in a URL). A separate `migrator` role comes in Phase 1, see section 4 | On leak (`ALTER ROLE`, `.env`, restart) |
| `POSTGRES_APP_PASSWORD` | server (role `app`); migrate sets it | `.env`, PM | `openssl rand -hex 32`, 64 hex chars; the deploy refuses other values | On leak: `.env` and PM, then run the migrate service (it sets the new password) and restart the server; a deploy of the running SHA is a no-op |
| `backup_dump` password | backup job | `.env` (backup service), PM | SELECT on `app`, `auth`, `drizzle`, allowed `pgboss` tables; none on `ebay_live` | On leak |
| healthchecks.io ping URLs | worker, backup, deploy | `.env`; the `deploy` URL in `/opt/ebay-sniper/deploy-ping-url` (`root:root 600`, one line; without the file the deploy skips its pings), PM | [ADR 0030](../adr/0030-heartbeats-and-external-probe.md) | On leak |
| SES key prod / dev | apps / local | `.env`, PM | `ses-sender-prod`; `ses-sender-dev` (simulator only) | On leak; prod yearly |
| `BETTER_AUTH_SECRETS` | server | `.env`, PM | `1:` + `openssl rand -base64 32` | Prepend `2:new,`; drop old after sessions expire |
| `ITEM_KEY_V1`, `ITEM_KEY_VERSION` | server, worker | `.env`, PM, offline copy | `openssl rand -base64 32` | Only on leak; loss breaks joins |
| Object storage put key | backup job | `.env`, PM | Upload only | On leak |
| Object storage verify key | `backup-verify.yml` (Phase 2) | Repository secret, PM; never on the host | List only | On leak |
| Object storage drill key | restore drill | PM only | `s3:GetObject`, `s3:GetObjectVersion` | After use in an incident |
| age identity | restore drill | PM plus offline copy; never on the host | `age-keygen` | On leak |
| Anthropic `prod`, `eval`, `dev` | worker; evals; Simon | `.env`; repository secret; local; PM | Service accounts (365 days); personal in `dev` | On leak, yearly |
| Langfuse keys | evals | Repository secret, PM | `https://cloud.langfuse.com` | On leak |
| GHCR pull token (later) | host | `/root/.docker/config.json` | PAT on a machine account, `read:packages` | Yearly |

### Creating the production `.env`

Run on the host as root:

```sh
install -d -m 700 -o root -g root /opt/ebay-sniper
install -m 600 -o root -g root /dev/null /opt/ebay-sniper/.env
openssl rand -hex 32                                    # deletion token, 64 chars
openssl rand -base64 30 | tr '+/' '-_' | tr -d '\n'    # DELETION_PROBE_CODE, 40 chars
openssl rand -hex 32                                    # POSTGRES_PASSWORD, POSTGRES_APP_PASSWORD
openssl rand -base64 32                                 # BETTER_AUTH_SECRETS entry, ITEM_KEY_V1
stat -c '%U:%G %a' /opt/ebay-sniper/.env                # must print root:root 600
install -m 600 -o root -g root /dev/null /opt/ebay-sniper/deploy-ping-url  # then write the healthchecks.io deploy URL into it
```

Values must not contain `$`: Compose interpolates them into the server and migrate settings.

Token rule: `^[A-Za-z0-9_-]{32,80}$`. Rotation: vendor console, `.env`, PM, `docker compose up -d`.

## 4. Environment variables

"From": phase from which production requires it. One Zod schema per app ([ADR 0006](../adr/0006-monorepo-package-boundaries-and-ports.md)) prints failing names, never values, and exits.

| Variable | Used by | From | Value / rule |
|---|---|---|---|
| `NODE_ENV`, `LOG_LEVEL`, `RUN_MODE` | all | 0 | pino level default `info`; `normal` or `restore-drill` |
| `PORT`, `PUBLIC_BASE_URL` | server | 0 | Host publishes `127.0.0.1:3140`; `https://deals.intra-ai.de` |
| `DATABASE_URL` | server, migrate | 0 | Not in `.env`; Compose builds it, for the server with role `app`, for migrate with role `ebay_sniper`. `MIGRATE_DATABASE_URL` is not used in Phase 0. See below |
| `POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD` | Postgres bootstrap and migrate; migrate and the server's URL | 0 | Lowercase hex; the `app` password is 64 hex chars. See below |
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | server, worker, contract | 0 | No token at startup, so a disabled keyset is harmless |
| `EBAY_MARKETPLACE_ID`, `EBAY_ENDUSERCTX_POSTAL_CODE` | worker, contract | 0 | `EBAY_DE`; encoded into `X-EBAY-C-ENDUSERCTX` |
| `EBAY_DELETION_ENDPOINT_URL` | server | 0 | Byte for byte the portal URL; absent, the route is skipped |
| `EBAY_DELETION_VERIFICATION_TOKEN`, `DELETION_PROBE_CODE` | server; the deploy checks the probe code | 0 | 64 chars; 40 chars of `[A-Za-z0-9_-]`, required (the server and the deploy refuse to start without it), a challenge with it writes `probe_seen` |
| `HEALTHCHECKS_PING_URL_<CHECK>` | worker | 0, 1 | `WORKER`, `DELETION_PROBE_SEEN`; `EBAY`, `HOST`, `SES_SUPPRESSION` |
| `CONTRACT_MAX_CALLS`, `CONTRACT_MIN_REMAINING` | contract | 0 | 100, 1500 (before polling starts) |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | server, worker | 1 | `eu-central-1`, `ses-sender-prod` |
| `SES_FROM_ADDRESS`, `SES_CONFIGURATION_SET`, `ALERT_RECIPIENT_ADDRESS` | server, worker | 1 | Matches `ses:FromAddress`; `ebay-sniper`; Simon's mailbox |
| `BETTER_AUTH_SECRETS`, `ITEM_KEY_V1`, `ITEM_KEY_VERSION` | server (+ worker) | 1 | `2:new,1:old`, first encrypts; 32 bytes base64; integer |
| `BACKUP_*` | backup job | 1-2 | Names fixed by the backup script |
| `ANTHROPIC_API_KEY`, `_WORKSPACE_ID`, `_MONTHLY_LIMIT_USD` | worker, eval | 3 | Worker checks the `anthropic-workspace-id` header; limit 360 |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | eval | 3 | `https://cloud.langfuse.com` |

**Phase 0 S3 (2026-10-20)**: two database roles. `ebay_sniper` is the image's superuser, owner of the `ebay_sniper` database and the migrator, with `POSTGRES_PASSWORD` from `.env`; a separate non-superuser `migrator` role is deferred to Phase 1. `app` is the server's role: `LOGIN`, not superuser, `statement_timeout` 2 s, `SELECT`, `INSERT` and `UPDATE` on `deletion_event`, `deletion_result_hourly`, `api_usage_hourly` and `probe_seen` only. Migration `0003_app_role` creates it; on every deploy `ops migrate` then sets its password from `POSTGRES_APP_PASSWORD`, sent as a SCRAM verifier (never the plaintext) under a cluster-wide role lock, and checks it by connecting as `app` and running the server's writes in a rolled-back transaction. A failure stops the deploy before the server is replaced. `DATABASE_URL` is not in `.env`: Compose builds `postgres://app:${POSTGRES_APP_PASSWORD}@postgres:5432/ebay_sniper` for the server and the `ebay_sniper` URL for `migrate`, which also gets `POSTGRES_APP_PASSWORD`. The server no longer loads the whole `.env` through `env_file`; it gets an explicit variable list, so `POSTGRES_PASSWORD` and secrets meant for other services are not in its environment. `POSTGRES_PASSWORD` takes effect only when the data volume is first created; a rotation is `ALTER ROLE ebay_sniper PASSWORD '...'` through `docker compose exec postgres psql`, then the `.env` edit and a deploy.

## 5. Checks

- Env schema tests: production refuses to start without each Phase 0 secret; `restore-drill` refuses eBay credentials, the notifier throws.
- CI fails if any workflow other than `evals.yml` and `backup-verify.yml` references a secret other than `GITHUB_TOKEN`, or if `evals.yml` has a trigger other than `workflow_dispatch` and `schedule`.
- The deploy script stops before Docker unless the revision is 40 hex characters, the script is `root:root 0755` and `.env` is `root:root 600`. The host has no `deploy` user.
- CI structure test of the SES policy JSON (`infra/aws/iam/`): prod has the two ADR 0022 statements; dev has `ForAllValues:StringLike` on `ses:Recipients`, `Null` false.
- Unit test: 31 x the alert and audit lane sum is at most the $360 `prod` limit; the settings CLI rejects lanes above `ANTHROPIC_MONTHLY_LIMIT_USD` / 31.
- Better Auth test on the pinned version: production starts with only `BETTER_AUTH_SECRETS`; a session made under `1:old` is still accepted after `2:new,1:old`. If it fails, use `BETTER_AUTH_SECRET` (a rotation then signs everyone out).
- Backup key check, before the first backup and at each drill: the put key uploads an object above rclone's multipart cutoff; reading, listing and deleting it all fail.
- Contract run: its count equals the `contract` rows in `api_usage_hourly`; a start-rule unit test covers a late-window refusal.
- Monthly, with the restore drill (4-hour target, `restore-drill` check fails after 35 days): Simon runs `scripts/anthropic-key-audit.ts` with an Admin key it creates with a short expiry and deletes after; it fails on any active key in the Default workspace or outside `prod` and `eval`. He reads spend limits by hand in the Console (not in the API) and records them.
- Register test: `docs/runbooks/secrets-register.yaml` matches each env schema; each entry has owner, rotation rule, `last_rotated`.
- Quarterly: Simon reviews the register, accounts and `aws iam simulate-custom-policy` for both SES policies.
