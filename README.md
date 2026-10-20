# just-buy-it

Find the deal, skip the scam, just buy it.

A deal monitor for used PC hardware on eBay.de. It watches listings for GPUs (RTX 3090/4090 first), DDR4/DDR5 RAM and gaming PCs, compares each price with a fair value, screens the listing for common scams with Claude, and sends an email alert. A person always makes the purchase through eBay's own checkout; the tool never buys, bids or messages sellers.

## Status

Early, Phase 0. What runs today:

- The server answers eBay's marketplace account deletion notifications (challenge, signature check, acknowledgement), which eBay requires before it enables a production keyset.
- A live Browse API search on EBAY_DE works with the production keyset.

Search, pricing, screening and alerts come next. The plan, decisions, ADRs and phase plans are in [`docs/`](docs/README.md).

## Layout

- `apps/server`: Hono server with the deletion endpoint, `/healthz` and `/privacy`
- `infra/`: Dockerfile, Compose file, a Traefik route and the deploy and smoke scripts for a shared Docker host
- `docs/`: planning, decision register, ADRs, phase plans

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

Copy `.env.example` and fill in the values. On a server, keep the file readable by root only (mode 600) and never commit it. Values must not contain `$`: Compose interpolates them into the server and migrate settings.

| Variable | Meaning |
| --- | --- |
| `EBAY_ENVIRONMENT` | `production` or `sandbox` |
| `EBAY_DELETION_ENDPOINT_URL` | Public HTTPS URL of `/ebay/account-deletion`, exactly as entered in the eBay portal |
| `EBAY_DELETION_VERIFICATION_TOKEN` | 32 to 80 characters of `[A-Za-z0-9_-]`, e.g. `openssl rand -hex 32` |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | App ID and Cert ID of the keyset, used to fetch eBay's signing keys |
| `POSTGRES_PASSWORD` | Password of the `ebay_sniper` database role (owner and migrator), hex only (`openssl rand -hex 32`) because Compose puts it into `DATABASE_URL`. Used only when the data volume is first created |
| `POSTGRES_APP_PASSWORD` | Required. Password of the `app` role the server connects as, 64 lowercase hex characters (`openssl rand -hex 32`). The migrate step sets it on every deploy; Compose puts it into the server's `DATABASE_URL` |
| `DELETION_PROBE_CODE` | Required. Secret challenge code for the external probe, 40 characters of `[A-Za-z0-9_-]`: `openssl rand -base64 30 \| tr '+/' '-_' \| tr -d '\n'`. The server and `ebay-deploy` refuse to start without it |
| `GIT_SHA` | 40-character commit SHA reported by `/healthz`. The image build sets it; do not put it in `.env`. For a local run, export any 40-character hex value |

## Deploy

The Compose file publishes the server on `127.0.0.1:3140` and expects a reverse proxy in front. Postgres 18 runs in the same Compose project, is not published on any host port, and keeps its data in the named volume `ebay-sniper-pgdata`, which survives container recreation and `docker compose down`. `infra/traefik/ebay-sniper.yml` is a Traefik file-provider route that passes only `/healthz`, `/privacy` and `/ebay/account-deletion` and refuses bodies over 64 KB; change the host name to your own domain.

Install the deploy script and the route once (as root on the host; put `.env` with `POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD` and `DELETION_PROBE_CODE` set in `/opt/ebay-sniper/.env` first, owned by `root:root` with mode 600, or `ebay-deploy` refuses to run):

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
```

`ebay-deploy` clones the repository into `/opt/ebay-sniper/repo`, checks that the commit is on `main`, checks `.env` and the ping URL file, sends the `/start` ping and exports the commit to `/opt/ebay-sniper/releases/<sha>/`. Then, in this order:

1. It builds the image. If the build fails, it stops; the running release is unchanged.
2. It brings Postgres to the new release's Compose config (`postgres: applying the config of <sha>` in the log). Compose recreates the container only if that config changed. If Postgres does not get healthy within 120 s, it stops.
3. It runs the database migrations once (`docker compose run --rm --no-deps -T migrate`) under `timeout 900`. The same step sets the `app` role password from `POSTGRES_APP_PASSWORD` and then checks the role by connecting as `app` and running the server's writes in a transaction that is rolled back; the migrate output in the deploy's terminal shows `app_role_check_passed`. If any of this fails or times out, it stops with the old server still running.
4. It starts the new server and waits until `/healthz` reports the SHA. If that fails it starts the previous release again and exits 1.

With a ping URL file, a deploy that goes live sends the success ping, and any failure after `/start` sends `/fail`, a rollback included. A refusal before `/start` (bad SHA, not on `main`, `.env` mode or a missing value) sends nothing. A failed ping prints a warning and does not change the exit code.

Migrations only add (ADR 0005), so a rollback never runs them in reverse. To roll back by hand, deploy an older SHA.

Then subscribe the endpoint in the eBay developer portal (Application Keys, Notifications, Marketplace Account Deletion) with the same URL and token, and send a test notification. The server log should show a line with `"result":"verified"`, followed by one with `"saved":true`, and `app.deletion_event` should have a row for it.

## eBay terms

This project is not affiliated with or endorsed by eBay. Anyone running it is responsible for complying with the eBay API License Agreement and eBay's policies for their use.

## License

[MIT](LICENSE)
