# ADR-0029: CI on GitHub Actions, deploy on the host, rollback

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0005, 0011, 0012, 0013, 0021, 0023, 0024; D-03, D-37

## Context

- Private repository on Simon's personal GitHub Free account, no branch protection (D-37). CI green, a fresh-context Claude Code review before merge and Simon's go before deploys are conventions.
- On Free, environment required reviewers exist only for public repositories ([GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)); CI gets no secret but `GITHUB_TOKEN` (ADR 0011).
- Production is the Compose project `/opt/ebay-sniper` on a shared Docker host behind Traefik (ADR 0012). The host can be busy and short on disk.
- ADR 0005: one migrate one-off container under an advisory lock; expand then contract; an older image may refuse a newer pg-boss schema.
- Phase 0 S3 is deployed by hand; it moves to this process when S1 and S2 land.

## Decision

Simon deploys on the host with `ebay-deploy <sha>` over SSH. Owner decision of 2026-10-20: until database migrations exist, the deploy is a simple script (below). The full version waits for the first migration (see "Later, when migrations exist"). Later CI pushes `sha-<commit>` to GHCR and the script pulls by digest instead of building.

**CI (`ci.yml`)**

| Trigger | Runs |
|---|---|
| Pull request | `turbo run lint typecheck test --affected`, Postgres 18 service, read-only permissions |
| Push to `main` | Full `lint typecheck test build`, then `docker build` (no push yet; later the only `packages: write` job) |
| Both | zizmor `unpinned-uses` (actions pinned by SHA) and `excessive-permissions` ([zizmor](https://docs.zizmor.sh/audits/)); `shellcheck` and the fake-tool tests of `infra/host/ebay-deploy`; lint of the root config files |

**`/healthz`** (ADR 0012): public, unauthenticated, exactly `{"sha":"<40-character commit SHA>"}` with `Cache-Control: no-store` and status 200. The SHA comes from `GIT_SHA`, set at image build; the server refuses to start without a valid one. There is no database check until a database exists; then it answers 503 when `select 1` takes longer than 2 s.

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

A failure before step 4 leaves the running containers alone. Manual rollback is `ebay-deploy <older sha>`. After each deploy Simon runs `infra/host/smoke https://deals.intra-ai.de <sha>` from outside: `/healthz` reports the SHA, `/privacy` is 200, the challenge answers with `challengeResponse`, a GET without code is 400, other paths are 404 and a 70 KB POST is 413.

**Later, when migrations exist**

- Stop unless `/opt/ebay-sniper/.env` is `root:root 600` (ADR 0011) and the filesystem holding `/var/lib/docker` has at least 10 GB free.
- Label the image with revision, cumulative `*_contract.sql` list and pg-boss version; refuse a target that lacks a contract migration the running image lists or has a lower pg-boss version.
- `docker compose run --rm migrate` before `up`; on failure write `failed` and stop with the old containers running.
- Record failed SHAs and refuse them; `ebay-deploy clear-failed` retries one.
- Keep only the running and previous images, prune other images and build cache.
- Ping healthchecks.io `deploy` on success or `deploy/fail` on failure ([ADR 0030](0030-heartbeats-and-external-probe.md)).
- `/healthz` checks the database (above).
- The smoke script adds the ADR 0021 client-address check: one send-code request for a reserved unknown address, then `auth_client_ip` from the server log over SSH must be `public`.

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
- Until the healthchecks.io pings exist, a failed deploy shows only in the SSH session and the smoke script.
- Until the disk floor, failed-SHA list and image pruning exist, a full disk or a repeated bad SHA is caught only by Simon.
- Host files change by hand and can drift from `infra/host/`.
- The host clones the public repository over HTTPS; a private repository would need a read-only deploy key again (ADR 0011).

**Risks**
- Build fails under load or full disk. Mitigation: the build runs before the old containers are replaced, a failed start rolls back, old release directories are pruned; the free-disk floor and image pruning come with migrations.
- Rollback fails too. Mitigation: deletion endpoint runbook; eBay allows 24 hours (ADR 0013).
- Migrate partly applies before failing. Mitigation: expand-only migrations, fix forward (ADR 0005).

## How we check it

- CI fails if any workflow uses a secret other than `GITHUB_TOKEN` (A10).
- Server test: `/healthz` returns exactly `{"sha":"<sha>"}` with `no-store`; the server refuses a missing or malformed `GIT_SHA`. The database case (200 with, 503 without) comes with the database.
- `tools/deploy-selftest` runs the real `ebay-deploy` with fake `git`, `docker` and `curl` (A11): an invalid SHA is refused; a SHA not on `main` is refused before docker runs; the running SHA is a no-op; success writes `running` and `previous` and prunes old releases; a wrong `/healthz` SHA rolls back to the old release and exits 1; a failed first deploy runs `down` and exits 1. The migrate, failed-SHA, disk and `.env` cases come with the full version.

## Revisit when

- Host builds are too slow or fill the disk: switch to the GHCR pull.
- Branch protection, a plan change or a second approver.
- Staging, a second host or zero-downtime deploys.
