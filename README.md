# just-buy-it

Find the deal, skip the scam, just buy it.

A deal monitor for used goods on eBay.de. The owner sets up products in a signed-in web console: search words, the words a title must and must not contain, a category, conditions and a price rule (a fixed maximum, or a percentage below the typical asking price). The worker polls eBay for each product, drops wrong items with generic word rules, checks the rest with Claude for the wrong product and common scams, and sends an email alert. A person always makes the purchase through eBay's own checkout; the tool never buys, bids or messages sellers.

## Status

v2. What it does:

- The server answers eBay's marketplace account deletion notifications (challenge, signature check, acknowledgement), which eBay requires before it enables a production keyset, plus `/healthz` and `/privacy`.
- The web service is the console at `https://deals.intra-ai.de`, open only to approved people who sign in with an emailed code (roles admin and editor). Products, settings, people, the call budget, deals and activity are managed there. No product, category or price lives in the code; they are rows in Postgres.
- The worker derives eBay searches from the products, polls them through the Browse API within a planned budget of 2,500 calls a day, and sweeps each product hourly by price when its price-drop check is on. Generic rules (must words, exclude words, junk and accessory rules, the price band) drop wrong items.
- Once a night it reads the asking prices of each product's listings and computes a typical asking price per condition group. A product priced "below the typical asking price" uses it for its limit; without a reliable value the alert says "using your cap".
- Each remaining candidate gets one Claude check (product match, verdict, risk flags, short reason) while the daily caps last, and one alert email over SMTP. The model, the effort and the caps are settings under ceilings from `.env`. Claude never decides a purchase.

The plan, decisions, ADRs and phase plans are in [`docs/`](docs/README.md); running it is in [`docs/runbooks/mvp-operations.md`](docs/runbooks/mvp-operations.md).

## Layout

- `apps/server`: Hono server with the deletion endpoint, `/healthz` and `/privacy`
- `apps/web`: the console (Hono JSX, server-rendered, the Intra AI design system's CSS): sign-in, products, settings, budget, people, activity, deals
- `apps/worker`: pg-boss jobs: poll-tick, poll, sweep, enrich (getItem), Claude check, alert email, relay, purge, market snapshots, category suggestions, held re-queue; `mail:test`
- `apps/ops`: one-off CLI: `migrate` (also sets the role passwords, adds the bootstrap admins and installs the pg-boss schema), `products`, `searches`, `plan`, `settings`, `auth`
- `packages/domain` (pure rules, no dependencies: matcher, product schema, search planner, call budget, market value), `db` (schema, migrations, stores, `db/queue`), `ebay`, `kleinanzeigen` (saved-search alert mails, not wired yet), `llm` (Claude over `fetch`, offline eval set), `notify` (SMTP), `logging`
- `infra/`: Dockerfile, Compose file, a Traefik route and the deploy, smoke and live-check scripts for a shared Docker host
- `tools/`: deploy self-test, dependency-rule self-test, design system sync, and the guard that keeps product words out of the code
- `docs/`: planning, decision register, ADRs, phase plans, runbooks

## What still mentions hardware, and why

The first products were graphics cards, RAM and gaming PCs. Since v2 they are data. The guard test `tools/no-product-literals` fails when code under `apps/*/src` or `packages/*/src` names them. These places still do:

| Place | Why it stays |
| --- | --- |
| `packages/db/migrations/0004`, `0006` | Migrations are history and never edited; 0006 seeds the legacy tables v2 does not read |
| `packages/db/src/schema/app.ts` legacy table checks | Must match the database until a contract migration drops `app.feed` and `app.segment_rule` |
| The live database: `app.feed`, `app.segment_rule`, history rows with `gpu_3090` etc. | Data, not code; kept for a rollback to Release 0 and for history |
| `packages/domain/fixtures/match-cases.v1.json`, `packages/llm/evals/cases` | Test data; about two thirds are hardware examples because those are real past cases |
| `docs/planning/*`, ADRs up to 0036, `docs/compliance/gates.md` | Written history |

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

Copy `.env.example` and fill in the values. On a server, keep the file readable by root only (mode 600) and never commit it. Values must not contain `$`: Compose interpolates them into the server, worker, web and migrate settings. Never `source` the file in a shell: `ALERT_FROM` and `LOGIN_FROM` hold spaces and angle brackets, unquoted.

| Variable | Meaning |
| --- | --- |
| `EBAY_ENVIRONMENT` | `production` or `sandbox` |
| `EBAY_DELETION_ENDPOINT_URL` | Public HTTPS URL of `/ebay/account-deletion`, exactly as entered in the eBay portal |
| `EBAY_DELETION_VERIFICATION_TOKEN` | 32 to 80 characters of `[A-Za-z0-9_-]`, e.g. `openssl rand -hex 32` |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | App ID and Cert ID of the keyset. The server uses them to fetch eBay's signing keys; the worker needs them for Browse calls |
| `POSTGRES_PASSWORD` | Password of the `ebay_sniper` database role (owner and migrator), hex only (`openssl rand -hex 32`) because Compose puts it into `DATABASE_URL`. Used only when the data volume is first created |
| `POSTGRES_APP_PASSWORD` | Required. Password of the `app` role the server connects as, 64 lowercase hex characters (`openssl rand -hex 32`). The migrate step sets it on every deploy; Compose puts it into the server's `DATABASE_URL` |
| `DELETION_PROBE_CODE` | Required. Secret challenge code for the external probe, 40 characters of `[A-Za-z0-9_-]`: `openssl rand -base64 30 \| tr '+/' '-_' \| tr -d '\n'`. The server and `ebay-deploy` refuse to start without it |
| `POSTGRES_WORKER_PASSWORD` / `POSTGRES_WEB_PASSWORD` | Required. Passwords of the `worker` role and the `web` role, 64 lowercase hex characters each (`openssl rand -hex 32`). The migrate step sets them on every deploy |
| `POSTGRES_DASHBOARD_PASSWORD` | Required. Password of the read-only `dashboard` role, 64 lowercase hex characters. v2 has no dashboard; the role is kept for a rollback to Release 0 until a contract migration drops it, and the migrate step still sets it |
| `ITEM_KEY_V1` | Required. Secret for the item keys, `openssl rand -base64 32` (44 characters). Keep an offline copy |
| `AUTH_KEY` | Required. Key for sign-in codes, sessions and devices, `openssl rand -base64 32`. Used by web and the ops CLI only |
| `AUTH_BOOTSTRAP_ADMINS` | Required. Addresses, separated by commas without spaces, that `ops migrate` makes admin while no active admin exists (`info@intra-ai.de`) |
| `PUBLIC_ORIGIN` | Required. Exactly `https://deals.intra-ai.de`; form posts must come from it |
| `LOGIN_SMTP_HOST`, `LOGIN_SMTP_PORT`, `LOGIN_SMTP_USER`, `LOGIN_SMTP_PASSWORD`, `LOGIN_FROM` | All five or none. The sign-in mailbox `noreply@intra-ai.de`, never the alert mailbox. With none set, people sign in with `ops auth code` only |
| `ALERT_TO` | Required. Recipient of every alert email; a product can add approved people in Bcc |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `ALERT_FROM` | All five or none. Port 587 uses STARTTLS. `ALERT_FROM` is an address or `Name <address>`, unquoted. With none set, alerts stay pending |
| `ANTHROPIC_API_KEY` | Optional. Without it, alerts say "Not checked by Claude" |
| `CLAUDE_DAILY_CALL_LIMIT` / `CLAUDE_DAILY_SPEND_LIMIT_USD` | Optional, defaults 40 and 2 per Berlin day. Ceilings: the settings in the console can only be lower. 0 switches the Claude check off |
| `BUYER_PROFILE`, `EBAY_ENDUSERCTX_POSTAL_CODE`, `DB_STATEMENT_TIMEOUT_MS`, `LOG_LEVEL` | Optional; empty means the default (`company`, `80331`, `10000`, `info`). The Claude model is a setting in the console, not a variable; `ebay-deploy` warns about a leftover `CLAUDE_MODEL` |
| `GIT_SHA` | 40-character commit SHA reported by `/healthz`. The image build sets it; do not put it in `.env`. For a local run, export any 40-character hex value |

## Deploy

The Compose file publishes the server on `127.0.0.1:3140` and the web service on `127.0.0.1:3141`, and expects a reverse proxy in front. The worker has no ports. Postgres 18 runs in the same Compose project, is not published on any host port, and keeps its data in the named volume `ebay-sniper-pgdata`, which survives container recreation and `docker compose down`. `infra/traefik/ebay-sniper.yml` is a Traefik file-provider route: `/healthz`, `/privacy` and `/ebay/account-deletion` go to the server first, sign-in posts to web behind their own rate limit, everything else to web; bodies over 64 KB are refused. Change the host name to your own domain.

Install the deploy script and the route once (as root on the host; put `.env` with the required values above, and the SMTP and sign-in mail values each all set or all absent, in `/opt/ebay-sniper/.env` first, owned by `root:root` with mode 600, or `ebay-deploy` refuses to run). The installed script never updates itself: when a release changes `infra/host/ebay-deploy`, install the new one by hand before deploying it ([runbook](docs/runbooks/mvp-operations.md), section 1).

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

`smoke` also checks that a console page without a session is 303 to `/login`, that `/login` and `/privacy` send the content security policy, and that port 3142 (the old dashboard) takes no connection. `live-check` runs on the host as root and checks the worker's health, the web service's `/healthz`, the pg-boss schema version, the heartbeat, the last poll of every search, content age, deliveries and today's Claude use.

`ebay-deploy` clones the repository into `/opt/ebay-sniper/repo`, checks that the commit is on `main`, checks `.env` and the ping URL file, sends the `/start` ping and exports the commit to `/opt/ebay-sniper/releases/<sha>/`. Then, in this order:

1. It builds the image. If the build fails, it stops; the running release is unchanged.
2. It brings Postgres to the new release's Compose config (`postgres: applying the config of <sha>` in the log). Compose recreates the container only if that config changed. If Postgres does not get healthy within 120 s, it stops.
3. It runs the database migrations once (`docker compose run --rm --no-deps -T migrate`) under `timeout 900`. The same step sets the `app`, `worker`, `dashboard` and `web` role passwords and checks each role by connecting as it in a transaction that is rolled back, adds the bootstrap admins when no active admin exists, and installs the pg-boss schema (version 46) and its queues. If any of this fails or times out, it stops with the old services still running.
4. It starts the new server and waits until `/healthz` reports the SHA. If that fails it starts the previous server again and exits 1.
5. It starts the new web service and waits until its `/healthz` on `127.0.0.1:3141` reports the SHA. If that fails it puts the previous server and web service back and exits 1. A release without a web service (Release 0 or older) stops the web container.
6. If the release defines a worker, it starts the new worker and waits up to 90 s for its healthcheck (a heartbeat file the worker touches every 10 s). If that fails it puts the previous release back (or stops a service the previous release does not have) and exits 1. With no previous release it stops everything.

With a ping URL file, a deploy that goes live sends the success ping, and any failure after `/start` sends `/fail`, a rollback included. A refusal before `/start` (bad SHA, not on `main`, `.env` mode or a missing value) sends nothing. A failed ping prints a warning and does not change the exit code.

Migrations only add (ADR 0005), so a rollback never runs them in reverse. To roll back by hand, deploy an older SHA; the runbook (section 1) says what a rollback from v2 to Release 0 leaves behind.

Then subscribe the endpoint in the eBay developer portal (Application Keys, Notifications, Marketplace Account Deletion) with the same URL and token, and send a test notification. The server log should show a line with `"result":"verified"`, followed by one with `"saved":true`, and `app.deletion_event` should have a row for it.

## eBay terms

This project is not affiliated with or endorsed by eBay. Anyone running it is responsible for complying with the eBay API License Agreement and eBay's policies for their use.

## License

[MIT](LICENSE)
