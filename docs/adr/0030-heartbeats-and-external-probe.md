# ADR-0030: Heartbeats and external probe of the deletion endpoint

**Date**: 2026-10-19
**Status**: proposed; accepted at Phase 0 S3 (probe and Phase 0 checks)
**Related**: ADR 0011, 0012, 0013, 0022, 0024, 0025, 0029; D-02, D-03, D-37, D-48

## Context

- healthchecks.io is passive ([docs](https://healthchecks.io/docs/)): a host ping does not prove eBay reaches the endpoint through DNS, TLS and Traefik.
- eBay marks the callback URL down after 24 hours of unacknowledged notifications, non-compliant after 30 days ([eBay](https://developer.ebay.com/marketplace-account-deletion)).
- healthchecks.io free: 20 checks ([pricing](https://healthchecks.io/pricing/)); email unverified until the phase 2 drill.
- UptimeRobot free: 5-minute keyword monitors, commercial use allowed ([fair use](https://uptimerobot.com/terms-fair-use/)). Solo: EUR 9 to 10 a month.
- GitHub Actions schedules can be delayed or dropped ([docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)); GitHub Free: 2,000 minutes a month.
- Anyone can send a challenge code, so a published code proves nothing (ADR 0013).
- Shared host: it can be busy, so cron jobs can run late.

## Decision

healthchecks.io checks watch worker, eBay, backups, deploys and host, alerting by its own email to Simon's mailbox (D-48). An UptimeRobot keyword monitor sends the deletion challenge with a secret probe code every 5 minutes and checks the hash. Intra AI holds both accounts (D-02).

| Check | Pinged by | Period / grace | Phase |
|---|---|---|---|
| `worker` | pg-boss cron job: `select 1`, queue counts | 5 min / 10 min | 0 |
| `deletion-probe-seen` | worker job, only if `probe_seen` is under 15 min old | 5 min / 30 min | 0 (S4) |
| `deploy` | deploy run (ADR 0029): `/start`, then success or `/fail` | 365 days / 30 min | 0 (S3) |
| `ebay` | same job: poll succeeded in 20 min, no breaker open | 5 min / 15 min | 1 |
| `backup` | host timer: `/start`, success after rclone exits 0 (ADR 0025) | 1 day / 3 h | 1 |
| `host` | systemd timer: disk, memory, load, our services running | 15 min / 15 min | 1 |
| `ses-suppression` | hourly suppression lookup (ADR 0022) | 1 h / 1 h | 1 |
| `backup-verified` | off-host job: newest object under 26 h, size in band | 1 day / 6 h | 2 |
| `restore-drill` | Simon after the drill checklist (ADR 0011) | 35 days / 1 day | 2 |

- 9 of 20 checks; a new check joins this table in the PR that adds its ping.
- `deploy` is pinged only by deploys, so a short period would mark it down after every deploy. healthchecks.io allows periods and grace times from 60 s to 365 days ([API docs](https://healthchecks.io/docs/api/), read 2026-10-20), and a `/start` without a success ping inside the grace time marks the check down ([docs](https://healthchecks.io/docs/measuring_script_run_time/)). With 365 days / 30 min, `/fail` alerts at once and a deploy that started but did not finish within 30 minutes alerts too; 30 minutes covers the 900 s migrate timeout, the build and the 60 s `/healthz` wait.
- Grace times of 10, 15 and 30 minutes allow for cron jobs delayed by host load. `host` thresholds come from a week of phase 1 readings.
- `worker`, `ebay`, `deletion-probe-seen` share the scheduler. `docs/runbooks/heartbeats.md` checks `host` first: high load suggests delay, green a stuck scheduler, a stopped service a dead container; `ebay` alone an eBay fault.

Probe rules:
- Monitor: `GET https://deals.intra-ai.de/ebay/account-deletion?challenge_code=<probe code>`; alert on status not 200 or missing expected `challengeResponse` (from the ADR 0013 shell vector).
- `DELETION_PROBE_CODE`: 40 random chars from `[A-Za-z0-9_-]`, only in `/opt/ebay-sniper/.env` and the monitor URL (secrets register, ADR 0011).
- The server answers every challenge alike. On a constant-time match with the probe code it upserts `app.probe_seen(seen_at)` (one row, overwritten) without waiting for the write, at most once a minute counted from the last attempt, so a down database is not hit on every probe; a failed write logs `probe_seen_unsaved` at most every 10 minutes. Every challenge reply has `Cache-Control: no-store`; no new outbound call (ADR 0007); the app never logs the probe code (ADR 0024).
- Traefik access logging lives in the shared static config; our route file cannot strip the query. Phase 0: check on the host whether access logs record the query. If so, turn them off for our router (`observability.accessLogs: false`, if 3.6 allows) or record the exposure and add the logs to the probe code rotation steps.
- Dated vendor pages go in `docs/compliance/vendors/` for the monthly terms diff.

**S3 amendment (2026-10-20)**: the server writes `probe_seen` from S3. The worker job that pings `deletion-probe-seen`, the check and `HEALTHCHECKS_PING_URL_DELETION_PROBE_SEEN` come with the worker in S4; a ping from the server would be the very signal it is meant to check. Until S4, UptimeRobot alerts on endpoint faults, and nothing notices UptimeRobot itself stopping. The `deploy` check uses 365 days / 30 min with `/start` (above) instead of 2 min / 10 min.

## Alternatives considered

- Host pings only: blind to DNS, certificate, route or token faults.
- UptimeRobot Solo now: EUR 108 to 120 a year; first fallback.
- GitHub Actions probe: runs delayed or dropped, about 1,440 of 2,000 minutes at 30 minutes; fallback.
- Public probe code: anyone could keep `deletion-probe-seen` green and write rows.

## Consequences

- Positive: the endpoint is checked as eBay reaches it, every 5 minutes; faults before the server raise both alerts; heartbeat mail needs neither SES nor the worker.
- Negative: two vendors and register entries; a probe code leak means new code, env deploy, monitor update.
- Negative: noisy neighbours can cause false `worker`, `ebay` or `deletion-probe-seen` alerts.
- Risk: probe stops silently. Mitigation: `deletion-probe-seen` goes down within 35 minutes (from S4).
- Risk: no free-plan email on healthchecks.io. Mitigation: phase 2 drill, UptimeRobot meanwhile, else paid plan.
- Risk: host load delays the cron job. Mitigation: the grace times, phase 1 `host` readings before thresholds are fixed, runbook checks `host` first.
- Risk: token, URL or probe code rotated without the monitor. Mitigation: the rotation runbook updates the monitor hash before saving in the eBay portal (ADR 0013).

## How we check it

- Server tests: probe code writes `probe_seen`; other codes get the right hash, no write; 100 probes a minute give one write; database stopped still gives 200 and the right hash; `no-store` set; no log line holds the probe code.
- Phase 0 drill (A9, `docs/runbooks/deletion-endpoint.md`): stop the server, then move our route file out of `/opt/traefik/dynamic`, 15 minutes each; deploy a wrong token briefly; UptimeRobot emails arrive. After a probe run, grep Traefik logs for the probe code: no match unless the exposure is recorded.
- Phase 2 drill (AC-8, `docs/runbooks/heartbeats.md`): stopping the worker brings `worker`, `ebay`, `deletion-probe-seen` emails within grace; pausing the monitor takes `deletion-probe-seen` alone down within 35 minutes.

## Revisit when

- UptimeRobot changes free-plan terms or becomes unusable; eBay changes how it checks the endpoint.
- More than 20 checks, or healthchecks.io email needs a paid plan.
- The phase 2 drill shows healthchecks.io free-plan email does not arrive.
- The app leaves the shared host.
