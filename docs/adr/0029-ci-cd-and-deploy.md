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

Simon deploys on the host with `ebay-deploy <sha>` over SSH (steps below). Later CI pushes `sha-<commit>` to GHCR and the script pulls by digest instead of building.

**CI (`ci.yml`)**

| Trigger | Runs |
|---|---|
| Pull request | `turbo run lint typecheck test --affected`, Postgres 18 service, read-only permissions |
| Push to `main` | Full `lint typecheck test build`, then `docker build` (no push yet; later the only `packages: write` job) |
| Both | zizmor `unpinned-uses` (actions pinned by SHA) and `excessive-permissions` ([zizmor](https://docs.zizmor.sh/audits/)) |

**`/healthz`** (ADR 0012): public, unauthenticated, exactly `{"sha": "<40-character commit SHA>"}` with `Cache-Control: no-store`; 200 when `select 1` answers within 2 s, else 503.

**What ships how**

- `infra/docker-compose.yml` and app config ship with each release from the checkout in `releases/<sha>/`.
- `infra/host/` holds the Traefik route `/opt/traefik/dynamic/ebay-sniper.yml` (points only at `127.0.0.1:3140`), the `ebay-deploy` script and any daemon or log settings. Simon installs them by hand over SSH, logs the change in the host runbook and reverts a bad route file by hand. The script never replaces itself.

**Deploy steps** (`/usr/local/sbin/ebay-deploy`, root, under `flock`; state in `/var/lib/ebay-deploy/`: `running`, `previous`, `failed`)

1. If the SHA equals `running`, exit 0 with no change. Stop unless `/opt/ebay-sniper/.env` is `root:root 600` (ADR 0011) and the filesystem holding `/var/lib/docker` has at least 10 GB free. Stop if the SHA is not on `origin/main` or equals `failed`.
2. Check out into `releases/<sha>/` (read-only deploy key) and build `ebay-sniper:sha-<sha>` labelled with revision, cumulative `*_contract.sql` list, pg-boss version.
3. Rollback guard: refuse if the target lacks a contract migration the running image lists, or has a lower pg-boss version. No migrate, no restart.
4. `docker compose -p ebay-sniper -f releases/<sha>/docker-compose.yml run --rm migrate`. On failure write `failed` and stop; the old containers keep running.
5. `up -d --wait --wait-timeout 120` from `releases/<sha>/`.
6. `https://deals.intra-ai.de/healthz` must return 200 with the new SHA within 60 s.
7. Success: `running` becomes `previous`; keep the last five release directories and the running and previous images, prune other images and build cache. Failure in 5 or 6: run step 5 from the previous release directory with the previous image (no down migrations), check its SHA, write `failed`.
8. Ping healthchecks.io `deploy` on success or `deploy/fail` on failure ([ADR 0030](0030-heartbeats-and-external-probe.md)).

Manual rollback is `ebay-deploy <older sha>`, with the same guard; it reuses a kept release directory and image, else rebuilds (slow, needs the disk floor). `ebay-deploy clear-failed` retries a failed SHA. After each deploy Simon runs the smoke script from outside: the Phase 0 paths answer, others 404, and the ADR 0021 client-address check sends one send-code request for a reserved unknown address and reads `auth_client_ip` from the server log over SSH (not from `/healthz`, which has one field); it must be `public`.

## Alternatives considered

- **GHCR pull from day one**: needs a classic PAT on a machine account first; deferred.
- **SSH from the GitHub runner**: GitHub would hold a credential for the shared host.
- **Self-hosted runner**: runs workflow code with Docker (root) on the shared host.
- **Push-to-deploy on `main`**: no go by Simon (D-37).
- **Watchtower**: no migrate, no health rollback.
- **Systemd timer on a `production` tag**: needs GHCR; Simon starts every deploy anyway.

## Consequences

**Positive**: no CI credential on the host; one command per deploy; migrate before restart; scripted rollback; a failed SHA is not retried.

**Negative**
- Builds are slow and use CPU and disk on the loaded host.
- The host rebuilds the image; not the bytes CI built.
- Review and go are conventions; nothing in GitHub enforces them.
- A failed deploy alerts only through healthchecks.io `deploy/fail` (ADR 0030), besides the SSH session and the smoke script.
- Host files change by hand and can drift from `infra/host/`.
- The host holds a read-only deploy key (ADR 0011).

**Risks**
- Build fails under load or full disk. Mitigation: free-disk floor, build before migrate, old release keeps running, few images kept.
- Rollback fails too. Mitigation: deletion endpoint runbook; eBay allows 24 hours (ADR 0013).
- Migrate partly applies before failing. Mitigation: expand-only migrations, fix forward (ADR 0005).

## How we check it

- CI fails if any workflow uses a secret other than `GITHUB_TOKEN` (A10).
- Server test: `/healthz` returns exactly the key `sha`, 200 with a working database, 503 without.
- Integration test of `ebay-deploy` against a local Compose stack (A11): failing migrate leaves the old containers and writes `failed`; wrong `/healthz` SHA restores `previous` from its release directory; a failed SHA is not rebuilt; the running SHA is a no-op; the guard refuses a missing contract migration and a lower pg-boss version; `.env` at 0640, under 10 GB free (stubbed `df`) and a SHA not on `main` stop before any change.

## Revisit when

- Host builds are too slow or fill the disk: switch to the GHCR pull.
- Branch protection, a plan change or a second approver.
- Staging, a second host or zero-downtime deploys.
