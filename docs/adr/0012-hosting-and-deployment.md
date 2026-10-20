# ADR-0012: Hosting on a shared Docker host behind Traefik

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0007, 0011, 0013, 0021, 0024, 0025, 0029; D-03, D-37, D-48

## Context

- Owner decision of 2026-10-19: no dedicated VPS, no Caddy. The app runs on an existing shared Docker host (Ubuntu 24.04, Docker 29, Compose v5).
- That server runs Traefik v3.6 on the host network: file provider `/opt/traefik/dynamic`, Let's Encrypt resolver `le`, shared middlewares `redirect-to-https` and `hsts-headers`.
- The host is shared with other services, so memory and disk are not guaranteed.
- The A record for `deals.intra-ai.de` exists (D-03); client traffic is IPv4 only in version 1 (ADR 0021).
- eBay marks the deletion endpoint down after 24 hours of unacknowledged notifications ([eBay](https://developer.ebay.com/marketplace-account-deletion)).

## Decision

The app runs as its own Compose project `ebay-sniper` in `/opt/ebay-sniper` (server, worker, Postgres 18 in its own container), bound to 127.0.0.1 only, behind the server's Traefik through one route file, `/opt/traefik/dynamic/ebay-sniper.yml`. CI/CD, deploy and rollback are in [ADR 0029](0029-ci-cd-and-deploy.md).

| Item | Setting |
|---|---|
| Ports | server `127.0.0.1:3140` only; Postgres and worker unpublished; `psql` via `docker compose exec` |
| Route | `Host(deals.intra-ai.de)`, resolver `le`, `redirect-to-https`, `hsts-headers`, service `http://127.0.0.1:3140`. Phase 0 routes only `/ebay/account-deletion`, `/privacy`, `/healthz`; later phases add dashboard and API paths. `/internal/*` never routed (`ssh -L`) |
| Own middlewares | `buffering` `maxRequestBodyBytes` 65536 on the Phase 0 router (413 above 64 KB, ADR 0013); later dashboard and API paths get their own router with a second `buffering` middleware of 1 MB; `X-Content-Type-Options`, `Referrer-Policy`, CSP `default-src 'self'; frame-ancestors 'none'` |
| Limits in the app | Hono `bodyLimit` 64 KB on the deletion path (ADR 0013); Better Auth database limiter for login (ADR 0021); per-IP limiter on other API routes; deletion path exempt |
| Client address | Traefik sees the real peer and writes `X-Forwarded-For`; the server trusts only that single entry |
| Env file | `/opt/ebay-sniper/.env`, `root:root 600` (ADR 0011) |
| Compose | `pgdata` with fixed `name:`; `json-file` `max-size: 20m`, `max-file: 5`; `restart: unless-stopped`; `init: true` for Node; healthcheck per long-running service |
| `mem_limit` (start) | postgres 512m (amended 2026-10-20 from 2g), worker 1536m, server 768m, migrate 256m (amended from 512m). Postgres runs with `max_connections` 30 and the default `shared_buffers`, on the owner's instruction to keep Postgres small (S1b, Q6); look again when Phase 1 polling runs |
| `stop_grace_period` | worker 180s (pg-boss graceful stop 170 s), server 30s, postgres 60s |
| `/healthz` | Public, only `{"sha": "<commit>"}`, `no-store`, 200. The `select 1` check (200 within 2 s, else 503) comes with the database |
| Backups | Server's `/opt/backups` practice plus our own dump without listing content (ADR 0025) |
| RTO | 4 hours, from the start of recovery until the deletion endpoint answers the challenge on `deals.intra-ai.de`. Inside the 4 hours: rebuild into a clean Compose project, data restore, DNS switch (TTL 300) and certificate. Same target on this host (Phase 0 S10 and monthly drill, ADR 0025) and on a fresh host (Phase 2 AC-3) |

## Alternatives considered

- **Dedicated VPS with Caddy (previous plan)**: another host to buy, harden and patch; replaced by the owner decision.
- **Own Caddy behind Traefik**: two proxies, two TLS paths, no gain.
- **Traefik Docker labels**: the server uses the file provider; one route file is easier to read and restore.
- **Fly.io or Railway**: about USD 51 a month before VAT, one more platform account.
- **Kubernetes**: control-plane overhead for two processes on one node.

## Consequences

**Positive**: no new host or certificate setup; TLS, redirects and HSTS come from the existing edge; only Traefik faces the internet; logs, memory and shutdown are bounded.

**Negative**: one shared host is one failure domain; we do not own its firewall, SSH policy or OS updates; root on the host reaches every service on it, and theirs reaches ours.

**Risks**
- Noisy neighbours delay jobs and slow the endpoint. Mitigation: 204 before verification (ADR 0013), memory limits, external probe every 5 minutes, ADR 0030 `host` check.
- A full disk stops Postgres. Mitigation: log limits, disk check before each deploy, few old images kept.
- Another service's Traefik change breaks our route. Mitigation: own route file, probe, runbook.
- Memory limits are guesses on a shared host. Mitigation: record `docker stats` peaks, resize.
- Endpoint down 24 hours. Mitigation: probe, rollback (ADR 0029), rebuild within 4 hours.

## How we check it

- `ss -tulnp` and an external `nmap`: 3140 and Postgres unreachable from outside (phase 0 A8).
- Smoke script from outside: the three Phase 0 paths answer, all others including `/internal/listings` get 404 (A7); over 64 KB on the deletion path gets 413 (A3).
- Proxy test: with a forged `X-Forwarded-For`, Better Auth sees the test client's address.
- CI test over `docker compose config`: only server has `ports`, all on `127.0.0.1`; every service has `max-size`, `mem_limit`, `restart`, `stop_grace_period`; worker at least 180s.
- Server test: `/healthz` returns only `sha` with `no-store`. The 503-without-database test comes with the database.
- Timed rebuild drill under 4 hours (A26); above that reopens this ADR.

## Revisit when

- The drill exceeds 4 hours, or host load or disk repeatedly delays jobs or the endpoint.
- Memory needs exceed what the host can give.
- The host owner moves the server or changes Traefik, or the hosting terms change.
- A second host, staging or zero-downtime deploys are needed.
