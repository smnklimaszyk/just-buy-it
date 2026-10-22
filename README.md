# just-buy-it

Find the deal, skip the scam, just buy it.

A deal monitor for used PC hardware on eBay.de. It watches listings for GPUs (RTX 3090/4090 first), DDR4/DDR5 RAM and gaming PCs, compares each price with a fair value, screens the listing for common scams with Claude, and sends an email alert. A person always makes the purchase through eBay's own checkout; the tool never buys, bids or messages sellers.

## Status

MVP. What it does:

- The server answers eBay's marketplace account deletion notifications (challenge, signature check, acknowledgement), which eBay requires before it enables a production keyset.
- The worker polls eBay.de through the Browse API for used RTX 3090, 3090 Ti and 4090 cards, DDR4 and DDR5 desktop RAM and gaming PCs with an RTX 4090. Rules in code drop wrong items and items above the owner's maximum landed price.
- Each remaining candidate gets one Claude Sonnet screening (verdict, risk flags, short reason) while the daily caps last (40 calls, USD 2), and one alert email over SMTP. Screening never decides a purchase.
- An internal dashboard on `127.0.0.1:3142` (SSH tunnel only) shows candidates, alerts, screenings, prices, quota use and the last poll per feed.

Fair value and tiers, auctions and sign-in come later. The plan, decisions, ADRs and phase plans are in [`docs/`](docs/README.md); running the MVP is in [`docs/runbooks/mvp-operations.md`](docs/runbooks/mvp-operations.md).

## Layout

- `apps/server`: Hono server with the deletion endpoint, `/healthz` and `/privacy`, plus the internal dashboard on its own listener
- `apps/worker`: pg-boss jobs: poll, sweep, enrich (getItem), Claude screening, alert email, relay, purge; `mail:test`
- `apps/ops`: one-off CLI: `migrate` (also sets the role passwords and installs the pg-boss schema), `feeds`, `rules`
- `packages/domain` (pure rules, no dependencies), `db` (schema, migrations, repositories, `db/queue`), `ebay`, `llm` (Claude over `fetch`, offline eval set), `notify` (SMTP), `logging`
- `infra/`: Dockerfile, Compose file, a Traefik route and the deploy, smoke and live-check scripts for a shared Docker host
- `docs/`: planning, decision register, ADRs, phase plans, runbooks

## Requirements

- Node 24 and pnpm 12 (`npx pnpm@12.12.1`)
- An eBay developer account with a production keyset (App ID and Cert ID)
- A public HTTPS URL for the deletion endpoint

## Local checks

```sh
npx pnpm@12.12.1 install
pnpm turbo run lint typecheck test --affected
pnpm turbo run lint typecheck test --filter=@ebay-sniper/server
pnpm depcruise
```

### Local Postgres for tests

The `packages/db` tests need Postgres 18. They fail, not skip, when `TEST_DATABASE_URL` is unset. Each test file creates its own database on that server.

```sh
docker run -d --rm --name ebay-sniper-test-pg -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:55432:5432 postgres:18.6-alpine
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres
pnpm --filter @ebay-sniper/db test
```

Stop it with `docker stop ebay-sniper-test-pg` (`--rm` removes the container and its data).

## Configuration

Copy `.env.example` and fill in the values. On a server, keep the file readable by root only (mode 600) and never commit it. Values must not contain `$`: Compose interpolates them into the server, worker and migrate settings. Never `source` the file in a shell: `ALERT_FROM` holds spaces and angle brackets, unquoted.

| Variable | Meaning |
| --- | --- |
| `EBAY_ENVIRONMENT` | `production` or `sandbox` |
| `EBAY_DELETION_ENDPOINT_URL` | Public HTTPS URL of `/ebay/account-deletion`, exactly as entered in the eBay portal |
| `EBAY_DELETION_VERIFICATION_TOKEN` | 32 to 80 characters of `[A-Za-z0-9_-]`, e.g. `openssl rand -hex 32` |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | App ID and Cert ID of the keyset. The server uses them to fetch eBay's signing keys; the worker needs them for Browse calls |
| `POSTGRES_PASSWORD` | Password of the `ebay_sniper` database role (owner and migrator), hex only (`openssl rand -hex 32`) because Compose puts it into `DATABASE_URL`. Used only when the data volume is first created |
| `POSTGRES_APP_PASSWORD` | Required. Password of the `app` role the server connects as, 64 lowercase hex characters (`openssl rand -hex 32`). The migrate step sets it on every deploy; Compose puts it into the server's `DATABASE_URL` |
| `DELETION_PROBE_CODE` | Required. Secret challenge code for the external probe, 40 characters of `[A-Za-z0-9_-]`: `openssl rand -base64 30 \| tr '+/' '-_' \| tr -d '\n'`. The server and `ebay-deploy` refuse to start without it |
| `POSTGRES_WORKER_PASSWORD` / `POSTGRES_DASHBOARD_PASSWORD` | Required. Passwords of the `worker` role and the read-only `dashboard` role, 64 lowercase hex characters each (`openssl rand -hex 32`). The migrate step sets them on every deploy |
| `ITEM_KEY_V1` | Required. Secret for the item keys, `openssl rand -base64 32` (44 characters). Keep an offline copy |
| `ALERT_TO` | Required. Recipient of the alert email |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `ALERT_FROM` | All five or none. Port 587 uses STARTTLS. `ALERT_FROM` is an address or `Name <address>`, unquoted. With none set, alerts stay pending |
| `ANTHROPIC_API_KEY` | Optional. Without it, alerts say "Not screened by Claude: not_configured" |
| `CLAUDE_DAILY_CALL_LIMIT` / `CLAUDE_DAILY_SPEND_LIMIT_USD` | Optional, defaults 40 and 2 per Berlin day; 0 switches screening off |
| `BUYER_PROFILE`, `EBAY_ENDUSERCTX_POSTAL_CODE`, `DB_STATEMENT_TIMEOUT_MS`, `LOG_LEVEL`, `CLAUDE_MODEL` | Optional worker settings; empty means the default (`company`, `80331`, `10000`, `info`, `claude-sonnet-5-5`) |
| `GIT_SHA` | 40-character commit SHA reported by `/healthz`. The image build sets it; do not put it in `.env`. For a local run, export any 40-character hex value |

## Deploy

The Compose file publishes the server on `127.0.0.1:3140` and expects a reverse proxy in front. The dashboard listener is published on `127.0.0.1:3142` only and is never routed; reach it with `ssh -L 3142:127.0.0.1:3142 <host>`. The worker has no ports. Postgres 18 runs in the same Compose project, is not published on any host port, and keeps its data in the named volume `ebay-sniper-pgdata`, which survives container recreation and `docker compose down`. `infra/traefik/ebay-sniper.yml` is a Traefik file-provider route that passes only `/healthz`, `/privacy` and `/ebay/account-deletion` and refuses bodies over 64 KB; change the host name to your own domain.

Install the deploy script and the route once (as root on the host; put `.env` with `POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD`, `DELETION_PROBE_CODE`, `POSTGRES_WORKER_PASSWORD`, `POSTGRES_DASHBOARD_PASSWORD` and `ITEM_KEY_V1` set, and the SMTP values all set or all absent, in `/opt/ebay-sniper/.env` first, owned by `root:root` with mode 600, or `ebay-deploy` refuses to run). The installed script never updates itself: when a release changes `infra/host/ebay-deploy`, install the new one by hand before deploying it ([runbook](docs/runbooks/mvp-operations.md), section 1).

```sh
scp infra/host/ebay-deploy <host>:/usr/local/sbin/ebay-deploy
ssh <host> chmod 755 /usr/local/sbin/ebay-deploy
scp infra/traefik/ebay-sniper.yml <host>:/opt/traefik/dynamic/ebay-sniper.yml
```

To get healthchecks.io pings for each deploy, write the check's ping URL as one line into `/opt/ebay-sniper/deploy-ping-url`, owned by `root:root` with mode 600 (`install -m 600 -o root -g root /dev/null /opt/ebay-sniper/deploy-ping-url`, then edit it). Without the file, `ebay-deploy` prints `no deploy ping URL, skipping healthchecks.io pings` and runs as usual; a file with other owner or mode makes it refuse to run.

Deploy a commit that is on `main`, then check it from outside:

```sh
ssh <host> ebay-deploy <sha>
infra/host/smoke https://<your-domain> <sha>
ssh <host> /opt/ebay-sniper/releases/<sha>/infra/host/live-check
```

`smoke` also checks that the dashboard paths are 404 on the public site and that port 3142 takes no connection there. `live-check` runs on the host as root and checks the worker's health, the dashboard's `/healthz`, the pg-boss schema version, the heartbeat, recent polls, content age, deliveries and today's Claude use.

`ebay-deploy` clones the repository into `/opt/ebay-sniper/repo`, checks that the commit is on `main`, checks `.env` and the ping URL file, sends the `/start` ping and exports the commit to `/opt/ebay-sniper/releases/<sha>/`. Then, in this order:

1. It builds the image. If the build fails, it stops; the running release is unchanged.
2. It brings Postgres to the new release's Compose config (`postgres: applying the config of <sha>` in the log). Compose recreates the container only if that config changed. If Postgres does not get healthy within 120 s, it stops.
3. It runs the database migrations once (`docker compose run --rm --no-deps -T migrate`) under `timeout 900`. The same step sets the `app`, `worker` and `dashboard` role passwords and then checks each role by connecting as it and running its work in a transaction that is rolled back; it also installs the pg-boss schema (version 46) and its queues. The migrate output in the deploy's terminal shows `pgboss_installed` and `app_role_check_passed`, `worker_role_check_passed`, `dashboard_role_check_passed`. If any of this fails or times out, it stops with the old server and worker still running.
4. It starts the new server and waits until `/healthz` reports the SHA. If that fails it starts the previous server again and exits 1; the worker is not touched.
5. If the release defines a worker, it starts the new worker and waits up to 90 s for its healthcheck (a heartbeat file the worker touches every 10 s). If that fails it puts the previous server and worker back (or stops the worker when the previous release has none) and exits 1. With no previous release it stops everything.

With a ping URL file, a deploy that goes live sends the success ping, and any failure after `/start` sends `/fail`, a rollback included. A refusal before `/start` (bad SHA, not on `main`, `.env` mode or a missing value) sends nothing. A failed ping prints a warning and does not change the exit code.

Migrations only add (ADR 0005), so a rollback never runs them in reverse. To roll back by hand, deploy an older SHA.

Then subscribe the endpoint in the eBay developer portal (Application Keys, Notifications, Marketplace Account Deletion) with the same URL and token, and send a test notification. The server log should show a line with `"result":"verified"`, followed by one with `"saved":true`, and `app.deletion_event` should have a row for it.

## eBay terms

This project is not affiliated with or endorsed by eBay. Anyone running it is responsible for complying with the eBay API License Agreement and eBay's policies for their use.

## License

[MIT](LICENSE)
