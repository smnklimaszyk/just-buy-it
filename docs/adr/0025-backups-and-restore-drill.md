# ADR-0025: Backups and restore drill

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0005, 0011, 0012, 0013, 0014, 0023, 0030; D-01, D-11, D-37

## Context

- Backups hold class 2 (`app`) and class 3 (operational) only, never class 1 (`ebay_live`) ([ADR 0014](0014-data-retention-classes-and-backups.md)).
- Shared Docker host: its `/opt/backups` practice plus our own dump ([ADR 0012](0012-hosting-and-deployment.md)). RTO 4 hours.
- pg-boss 12.38.0 partitions `pgboss.job` by queue (hashed names); `pgboss.warning.data` is free-form.

## Decision

Nightly, a one-shot container built on `postgres:18.6-trixie` dumps the database without `ebay_live` or pg-boss job data, encrypts it with age to an offline key, and uploads it with a put-only key to a versioned bucket off the server, where it lives at most 17 days (RPO 24 hours).

| Item | Choice |
|---|---|
| Trigger | Host systemd timer 03:30 Europe/Berlin runs `docker compose run --rm backup`; profile-gated, no Docker socket, not a pg-boss job |
| Owner | Simon (D-01): Phase 1 S7 base backup; Phase 2 pricing-table checks and off-host verify job |
| Role | `backup_dump`: SELECT on `app`, `auth`, `drizzle`, allowed `pgboss` tables; none on `ebay_live`. Fallback `--exclude-schema=ebay_live` plus a CI-built schema-only `ebay_live.sql`. Globals via `pg_dumpall --globals-only --no-role-passwords` |
| Image | `infra/backup/Dockerfile` from `postgres:18.6-trixie` plus Debian `age` 1.2.1 and Debian `rclone` (version checked at first build) |
| Dump | `pg_dump -Fc --exclude-table-data='ebay_live.*' --exclude-table-data-and-children='pgboss.job' --exclude-table-data='pgboss.job_dependency' --exclude-table-data='pgboss.warning'` |
| Encryption | `age -r age1...`; private key only in Simon's password manager and one offline copy |
| Keys | Upload (host, put only; must fail GET, LIST and DELETE in the key check), verify (GitHub Actions secret, list only), drill (password manager, `GetObject`, `GetObjectVersion`) |
| Upload | rclone `--s3-no-check-bucket --s3-no-head --no-check-dest`; name = UTC time + 8 random hex |
| Bucket | S3-compatible, separate account from the server (provider open); versioning; Expiration 14 days, NoncurrentDays 3 |
| Host backups | `/opt/backups` may copy `/opt/ebay-sniper` config, never the `pgdata` volume or `.env` |
| Heartbeat | healthchecks.io `backup` ping after rclone exits 0; daily `backup-verified` from the verify job ([ADR 0030](0030-heartbeats-and-external-probe.md)) |

A restore has empty `ebay_live` tables and keeps pg-boss version, queue and schedule rows; schedules re-register, polls rebuild the active set, and `item_key` uniqueness holds if the item-hash key is unchanged ([ADR 0013](0013-ebay-user-data-deletion-and-identifiers.md)).

**Restore drill (monthly).** Compose project `/opt/ebay-sniper-drill` on the host, own volume, `127.0.0.1:3141`, own route file for `drill.intra-ai.de` (as in Phase 0 S10), `RUN_MODE=restore-drill` (worker and notifier off), after a free-disk check. Fetch the newest dump (drill key), decrypt, restore into `postgres:18.6`, migrate (nothing pending), row counts match the backup log, `ebay_live` and `pgboss.job` empty, `/healthz` 200, run the backup key check ([ADR 0011](0011-environments-accounts-and-secrets.md)), time it against 4 hours, ping `restore-drill` (35-day period), remove it all. Checklist: `docs/runbooks/restore-drill.md`.

The drill times the full RTO of [ADR 0012](0012-hosting-and-deployment.md): rebuild, data restore, DNS switch of the drill record and certificate. A host rebuild also needs the `/opt/ebay-sniper` config from `/opt/backups`, the Traefik route `/opt/traefik/dynamic/ebay-sniper.yml`, and `.env` values from the password manager.

## Alternatives considered

Rejected: WAL archiving / PITR (archives `ebay_live`; a lost day costs little); full-disk or `pgdata` copies (class 1 data, not our key); Debian `postgresql-client` (17 refuses an 18 server, [docs](https://www.postgresql.org/docs/18/app-pgdump.html)); unencrypted dumps with a read-write key (a compromised host reads emails, deletes backups).

## Consequences

- **Positive**: a leaked dump holds at most 30 days of eBay-derived numbers, no listing content or raw item IDs; lifetime 17 days; drills test image and keys.
- **Negative**: fair value stale one refresh cycle after restore; a second image, a timer and three keys to own; exclusions track schemas and pg-boss.
- **Risks**:
  - Put-only policy may fail on rclone multipart ([forum](https://forum.rclone.org/t/s3-problems-with-put-only-buckets/44171)): key check uploads above the cutoff first; widen to `s3:Put*` if needed.
  - Put key overwrites dumps: versioning keeps 3 days, names unguessable; drill checks versions; add object lock if it ever happens.
  - Age key lost: all backups unreadable; two copies, drill decrypts each time. Nobody else can restore while Simon is unavailable.
  - Item-hash key lost or different: drill checks its fingerprint against the log.
  - Shared host overloaded or disk full delays or breaks dump or drill: heartbeat, disk check.

## How we check it

- Sentinel test (CI, ADR 0023): sentinels in `ebay_live` text and jobs; real `backup.sh` to a file; decrypted SQL has no sentinel but a known `app` row.
- Dump contents test: `pg_restore --list` `TABLE DATA` entries all on a committed allowlist (`app`, `auth`, `drizzle`; `pgboss` only `version`, `queue`, `schedule`, `subscription`, `bam`, `queue_stats`, `instance`).
- pg-boss table test on each version bump: `pgboss` tables and partitions match a committed list; every job partition has parent `pgboss.job`.
- `infra/backup/` and allowlist changes: CI green plus fresh-context review (D-37).
- Ops: both heartbeats; `restore-drill` check; AC-25 (Phase 1), P2-1 and AC-1 (Phase 2).

## Revisit when

- PostgreSQL major or pg-boss tables change; the backup key check fails.
- D-11 changes the lifetime, RPO under 24 hours is needed, or the dump takes over 30 minutes.
- The host, `/opt/backups` practice or bucket provider changes, or someone else can hold the age key.
