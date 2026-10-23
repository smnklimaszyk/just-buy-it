# ADR-0029: CI on GitHub Actions, deploy on the host, rollback

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0005, 0011, 0012, 0013, 0021, 0023, 0024; D-03, D-37

## Context

- Public repository on Simon's personal GitHub Free account (D-37). Ruleset on `main` (2026-10-20): changes go through a pull request, the `checks` and `zizmor` jobs must pass and the branch must be up to date; no force-push, no deletion, no bypass. No approving review is required. A fresh-context Claude Code review before merge and Simon's go before deploys are conventions.
- On Free, environment required reviewers exist only for public repositories ([GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)); CI gets no secret but `GITHUB_TOKEN` (ADR 0011).
- Production is the Compose project `/opt/ebay-sniper` on a shared Docker host behind Traefik (ADR 0012). The host can be busy and short on disk.
- ADR 0005: one migrate one-off container under an advisory lock; expand then contract; an older image may refuse a newer pg-boss schema.
- Phase 0 S3 is deployed by hand; it moves to this process when S1 and S2 land.

## Decision

Simon deploys on the host with `ebay-deploy <sha>` over SSH. Owner decision of 2026-10-20: until database migrations exist, the deploy is a simple script (below). The first migration (S1b) adds the steps under "With the first migration (S1b)"; the rest waits (see "Later"). Later CI pushes `sha-<commit>` to GHCR and the script pulls by digest instead of building.

**CI (`ci.yml`)**

| Trigger | Runs |
|---|---|
| Pull request | `turbo run lint typecheck test --affected`, Postgres 18 service, read-only permissions |
| Push to `main` | Full `lint typecheck test build`, then `docker build` (no push yet; later the only `packages: write` job) |
| Both | zizmor `unpinned-uses` (actions pinned by SHA) and `excessive-permissions` ([zizmor](https://docs.zizmor.sh/audits/)); `shellcheck` and the fake-tool tests of `infra/host/ebay-deploy`; lint of the root config files |

**`/healthz`** (ADR 0012): public, unauthenticated, exactly `{"sha":"<40-character commit SHA>"}` with `Cache-Control: no-store` and status 200. The SHA comes from `GIT_SHA`, set at image build; the server refuses to start without a valid one. It has no database check (S3 decision, 2026-10-20): the server works without Postgres by design (ADR 0013), and a 503 would mark the container unhealthy and make a deploy roll back a working server whenever Postgres is slow. Postgres health is covered by the deploy's Postgres step and the S4 `worker` heartbeat.

**What ships how**

- `infra/docker-compose.yml` and app config ship with each release in `releases/<sha>/`. The image is tagged `ebay-sniper-server:<sha>`.
- `infra/host/` holds the `ebay-deploy` script and the `smoke` script; `infra/traefik/ebay-sniper.yml` is the route `/opt/traefik/dynamic/ebay-sniper.yml` (points only at `127.0.0.1:3140`). Simon installs the script and the route by hand over SSH, logs the change in the host runbook and reverts a bad route file by hand. The script never replaces itself.

**Deploy steps** (`/usr/local/sbin/ebay-deploy <sha>`, root, under `flock`; everything under `/opt/ebay-sniper`: clone in `repo/`, releases in `releases/<sha>/`, state in `state/running` and `state/previous`)

1. Refuse anything but a 40-character lowercase SHA. If it equals `running`, exit 0 with no change.
2. Clone the public repository over HTTPS on first run, `git fetch origin main`, refuse unless the SHA is an ancestor of `origin/main`.
3. Export the tree with `git archive` into `releases/<sha>/` (no `.git`).
4. `GIT_SHA=<sha> docker compose -p ebay-sniper -f releases/<sha>/infra/docker-compose.yml up -d --build --wait --wait-timeout 120`.
5. `https://deals.intra-ai.de/healthz` must report the new SHA within 60 s.
6. Success: `running` becomes `previous`, the SHA becomes `running`; keep the five newest release directories plus the running and previous ones, delete the rest.
7. Failure in 4 or 5: run step 4 from the old running release with its SHA, check its `/healthz`, say that it rolled back, exit 1. With no running release, `docker compose -p ebay-sniper down` and exit 1.

A failure before step 4 leaves the running containers alone. Manual rollback is `ebay-deploy <older sha>`. After each deploy Simon runs `infra/host/smoke https://deals.intra-ai.de <sha>` from outside: `/healthz` reports the SHA, `/privacy` is 200, the challenge answers with `challengeResponse`, a GET without code is 400, other paths are 404 and a 70 KB POST is 413. From S3 it also checks that the challenge reply has `Cache-Control: no-store`, that `PUT /ebay/account-deletion` is 405 and that a POST of `{}` without a signature header is 204.

**With the first migration (S1b)** (amended 2026-10-20)

- Before any docker call, stop unless `/opt/ebay-sniper/.env` is `root:root 600` (ADR 0011) and sets `POSTGRES_PASSWORD` to a lowercase hex value. Every compose call passes `--env-file /opt/ebay-sniper/.env`, which supplies `POSTGRES_PASSWORD`; compose refuses every command without it, and the migrate `DATABASE_URL` embeds it without URL encoding.
- Step 4 is split. First `docker compose build server`; on failure stop, the running release is unchanged.
- Then `docker compose up -d --wait --wait-timeout 120 postgres` as its own logged step, so a change to the Postgres config shows in the deploy log. On failure stop; the server still runs the old release. There is no automatic Postgres rollback. S1b left it to S3 in case the server came to depend on Postgres; it does not (S3 decision): the server writes to Postgres, but the old server keeps answering with Postgres down, so none is added.
- Then `timeout 900 docker compose run --rm --no-deps -T migrate` before `up`. `--no-deps` keeps `run` from recreating Postgres as a side effect. On a timeout, stop the leftover one-off migrate container, then stop the deploy; on any other failure stop with the exit code. Either way the old containers keep running and nothing is rolled back, because nothing was replaced. On migrate failure S1b only stops; writing `failed` starts with the failed-SHA list in S4.
- Then `up -d --build --wait --wait-timeout 120 server` and the `/healthz` check as before. The up names only the server, so a Postgres health flap during this step does not fail it or roll back a healthy server; the rollback starts only the old server too. A rollback or the failed-first-deploy `down` never runs the Postgres step or migrate, and `down` never passes `-v`.
- A deploy needs a healthy Postgres, accepted on purpose. Migrations must run before the server that needs them, so the Postgres and migrate steps are not skipped when Postgres is down. While Postgres is down no release can deploy, including a fix to the deletion endpoint; the old server keeps answering the endpoint because it does not depend on Postgres (A4). Recovery is to fix Postgres first, then deploy.

**S3 additions (2026-10-20)**

- Before any docker call, also stop unless `.env` sets `POSTGRES_APP_PASSWORD` to 64 lowercase hex characters and `DELETION_PROBE_CODE` to 40 characters of `[A-Za-z0-9_-]`.
- The migrate step also sets the `app` role password and checks the role. After the migrations, `ops migrate` gives role `app` `LOGIN` and the password from `POSTGRES_APP_PASSWORD`, sent as a SCRAM verifier under a cluster-wide role lock, then connects as `app` and runs the server's own writes inside a transaction it rolls back. A failure exits 1, so the deploy stops at the migrate step before the server is replaced.
- healthchecks.io `deploy` pings ([ADR 0030](0030-heartbeats-and-external-probe.md)). The ping URL lives in `/opt/ebay-sniper/deploy-ping-url`. If the file exists it must be `root:root 600` and hold one `https://` URL on one line, else the deploy stops before any docker call; if it is absent, the deploy prints `no deploy ping URL, skipping healthchecks.io pings` and runs without pings. `/start` is sent after the no-op check and the SHA and `.env` checks, the success ping after `is live`, and `/fail` from every failure after `/start`, a successful rollback included (the new SHA did not go live). A refusal before `/start` sends nothing. Each ping is `curl -fsS --max-time 10 --retry 2`; a failed ping prints a warning and never changes the exit code.

**v2 additions (2026-10-22, with ADR 0037 to 0040)**: the deploy starts and checks `web`, and checks the new `.env` names.

- Before any docker call, also stop unless `.env` sets `AUTH_KEY` (32 bytes, base64), `POSTGRES_WEB_PASSWORD` (64 lowercase hex characters, like `POSTGRES_APP_PASSWORD`), `AUTH_BOOTSTRAP_ADMINS` (comma list of addresses; v2 starts with `info@intra-ai.de` only, ADR 0038) and `PUBLIC_ORIGIN` exactly `https://deals.intra-ai.de`, and sets either all or none of `LOGIN_SMTP_HOST`, `LOGIN_SMTP_PORT`, `LOGIN_SMTP_USER`, `LOGIN_SMTP_PASSWORD`, `LOGIN_FROM`, naming only the missing ones. A `CLAUDE_MODEL` still set gives a warning, not a stop.
- The migrate step also gives role `web` `LOGIN` and the password from `POSTGRES_WEB_PASSWORD`, the same way as role `app`, and adds the bootstrap admins only when no active admin exists.
- `up` starts `web` after `server`; `web`'s `/healthz` on `127.0.0.1:3141` must report the new SHA within 60 s, like the server's. A failure of either rolls both back to the running release. When the target release has no `web` service (Release 0 or older), the deploy stops `web`.
- Compose drops port 3142 and the MVP dashboard. `web` gets an explicit env list (including `CLAUDE_DAILY_CALL_LIMIT` and `CLAUDE_DAILY_SPEND_LIMIT_USD` for the settings ceilings, never `SMTP_PASSWORD`), `127.0.0.1:3141:3000`, a read-only root file system with tmpfs, `cap_drop: ALL`, `no-new-privileges`, `mem_limit: 192m` and `NODE_OPTIONS=--max-old-space-size=115`.
- The smoke script also checks that `/products` without a cookie is 303 to `/login`, that `/login` and `/privacy` send the CSP, and that `/login` sends `X-Frame-Options: DENY`. The deletion checks stay unchanged.
- The new Traefik route file (ADR 0038) is installed by hand after the v2 deploy, the import and the first sign-in over an SSH tunnel; the old file is kept next to it.
- Rollback from v2 to Release 0 is `ebay-deploy <sha of Release 0>`, then the old Traefik file put back by hand. Until the old file is back, other paths give 502 while the deletion endpoint keeps working by router priority. `poll` and `sweep` jobs that v2 left queued carry v2 payloads (`searchId`, `productKey`); each fails Release 0's payload check once and lands in `poll.dead` or `sweep.dead`, which is harmless (no retries, no eBay call). Jobs on queues Release 0 has no handler for (`market-snapshot`, `market-nightly`, `category-suggest`, `held-requeue`) are not worked. Product edits made in v2 do not flow back. The runbook carries these lines.

**Later**

- Stop unless the filesystem holding `/var/lib/docker` has at least 10 GB free (S4).
- Label the image with revision, cumulative `*_contract.sql` list and pg-boss version; refuse a target that lacks a contract migration the running image lists or has a lower pg-boss version (S4).
- Record failed SHAs and refuse them; `ebay-deploy clear-failed` retries one (S4).
- Keep only the running and previous images, prune other images and build cache (S4).
- The smoke script adds the ADR 0021 client-address check: one send-code request for a reserved unknown address, then `auth_client_ip` from the server log over SSH must be `public` (Phase 1).

## Alternatives considered

- **GHCR pull from day one**: needs a classic PAT on a machine account first; deferred.
- **SSH from the GitHub runner**: GitHub would hold a credential for the shared host.
- **Self-hosted runner**: runs workflow code with Docker (root) on the shared host.
- **Push-to-deploy on `main`**: no go by Simon (D-37).
- **Watchtower**: no migrate, no health rollback.
- **Systemd timer on a `production` tag**: needs GHCR; Simon starts every deploy anyway.

## Consequences

**Positive**: no CI credential on the host; one command per deploy; scripted rollback; the simple script is small enough to read in one sitting.

**Negative**
- Builds are slow and use CPU and disk on the loaded host.
- The host rebuilds the image; not the bytes CI built.
- Review and go are conventions; nothing in GitHub enforces them.
- Without the ping URL file, a failed deploy shows only in the SSH session and the smoke script.
- Until the disk floor, failed-SHA list and image pruning exist, a full disk or a repeated bad SHA is caught only by Simon.
- Host files change by hand and can drift from `infra/host/`.
- The host clones the public repository over HTTPS; a private repository would need a read-only deploy key again (ADR 0011).

**Risks**
- Build fails under load or full disk. Mitigation: the build runs before the old containers are replaced, a failed start rolls back, old release directories are pruned; the free-disk floor and image pruning come in S4.
- Rollback fails too. Mitigation: deletion endpoint runbook; eBay allows 24 hours (ADR 0013).
- Migrate partly applies before failing. Mitigation: expand-only migrations, fix forward (ADR 0005).

## How we check it

- CI fails if any workflow uses a secret other than `GITHUB_TOKEN` (A10).
- Server test: `/healthz` returns exactly `{"sha":"<sha>"}` with `no-store`; the server refuses a missing or malformed `GIT_SHA`. There is no database case (S3 decision, see `/healthz`).
- `tools/deploy-selftest` runs the real `ebay-deploy` with fake `git`, `docker`, `curl`, `stat` and `timeout` (A11): an invalid SHA is refused; a SHA not on `main` is refused before docker runs; the running SHA is a no-op; success writes `running` and `previous` and prunes old releases; a wrong `/healthz` SHA rolls back to the old release and exits 1; a failed first deploy runs `down` and exits 1. The `.env`, Postgres-step, migrate-failure, migrate-timeout and call-order cases come with S1b. S3 adds: `.env` without a 64-hex `POSTGRES_APP_PASSWORD` or a 40-character `DELETION_PROBE_CODE` stops before docker; no ping file means no ping and a deploy as before; a ping file with mode 644 stops before docker; success pings `/start`, then the URL; a failed migrate (a failed app role check included) pings `/start`, then `/fail`, and the server is not replaced; a rollback pings `/fail`; the no-op SHA pings nothing; a failing ping leaves the exit code unchanged. The failed-SHA, failed-digest, label and disk cases come with S4. v2 adds: success starts and checks `web`; a failed `web` health check rolls back both services; a rollback to a release without `web` stops it; each new `.env` refusal stops before docker, a partial `LOGIN_SMTP_*` set included.

## Revisit when

- Host builds are too slow or fill the disk: switch to the GHCR pull.
- Branch protection, a plan change or a second approver.
- Staging, a second host or zero-downtime deploys.
