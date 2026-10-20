# ADR-0008: Time storage, injected clock and schedule time zones

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0005, 0006, 0007, 0015, 0016, 0019, 0024, 0025; D-13, D-26, D-32

## Context

- Rule: store UTC, show Europe/Berlin with the zone name. Nothing enforces it: Drizzle `timestamp()` without `withTimezone: true` makes a plain `timestamp`, and Postgres silently ignores input zones on it ([Drizzle](https://orm.drizzle.team/docs/column-types/pg), [Postgres](https://www.postgresql.org/docs/18/datatype-datetime.html)).
- Polling follows Berlin time (every 2 min 07:00-23:00, every 10 min at night); 21:00 auction digest. One poll-tick per minute picks due feeds; `poll_run` is unique on (feed_id, scheduled_for) (ADR 0015).
- pg-boss `schedule()` takes `tz`, default UTC ([docs](https://pgboss.io/api/scheduling)). Cron behaviour in the repeated or missing DST hour is unverified.
- eBay getRateLimits `reset` is a UTC instant; quota windows are not calendar days.
- Next DST changes: 2026-10-25 (02:00-02:59 twice), 2027-03-28 (missing).
- `Date.now()` calls cannot be tested at a chosen instant without patching globals.

## Decision

Every timestamp is `timestamptz(3)` through one Drizzle helper, the database and containers run in UTC, and display uses Europe/Berlin with CET/CEST. Time-based decisions take an injected `Clock`; minute and interval jobs use UTC cron, wall-clock jobs use `tz: 'Europe/Berlin'` and never hour 2, and a budget "day" is the Berlin calendar day selected with UTC bounds.

| Area | Rule |
|---|---|
| Columns | `packages/db` helper `ts(name)` = `timestamp(name, { withTimezone: true, mode: 'date', precision: 3 })` on every table |
| Zones | Migrate step runs `ALTER DATABASE <db> SET timezone TO 'UTC'`; containers set `TZ=UTC` |
| Display | One formatter in `packages/domain` (`Intl.DateTimeFormat`, `timeZoneName: 'short'`); APIs send ISO 8601 with `Z` |
| Clock | `type Clock = { now(): Date }`, a plain argument, not a port. Only `apps/*/src/clock.ts` reads system time |
| DB `now()` | Defaults only on audit columns (`created_at`, `updated_at`, Better Auth equivalents) |
| Minute/interval jobs | poll-tick and relay `* * * * *`, purge `*/15 * * * *`, hourly digest `0 * * * *`, all `tz: 'UTC'` |
| Wall-clock jobs | Nightly fair-value refresh and 30-day price null-out (03:30 or later), 21:00 digest: `tz: 'Europe/Berlin'`, no hour 2. Backup runs from a host timer (ADR 0025) |
| Day/night polling | Pure domain function: Berlin local hour picks the interval (day 07:00-22:59); slot = UTC instant floored to the interval since epoch; due when no `poll_run` exists for the slot |
| One-off jobs | Checkpoints (T-150/60/15) and the 30-min recheck use absolute UTC `startAfter` |
| Counters | `*_hourly` tables key on `hour_utc timestamptz` (`date_trunc('hour', x, 'UTC')`); a Berlin day is `hour_utc >= $start AND < $end` from one domain function (23 or 25 h on DST days) |
| eBay quota | `reset` parsed as `timestamptz`, never converted; counting and pacing owned by ADR 0007/0016 |
| Host clock | Shared host's time sync; `poll_run` records skew against eBay's `Date` header |

## Alternatives considered

- **Plain `timestamp`, UTC by convention**: one missed option writes wrong values silently; relies on review alone.
- **Store Berlin local time**: 02:30 is ambiguous in October and impossible in March.
- **Global fake timers instead of `Clock`**: they patch pg-boss and the DB driver and make queue tests on real Postgres flaky. Allowed for adapter-internal timers.
- **Two Berlin crons per feed**: the night expression includes hour 2 (unverified), doubles schedules, conflicts with ADR 0015.
- **UTC cron for everything**: 21:00 digest and nightly jobs shift by an hour for half the year.
- **UTC days for budgets**: budgets reset at 01:00/02:00 Berlin and disagree with the dashboard.

## Consequences

- **Positive**: UTC rule enforced by tests; domain tests can pick any instant, including both 02:30s on 2026-10-25; polling across DST is decided by our tested code; UTC hour buckets serve Berlin or UTC day reports.
- **Negative**: one more parameter on time-dependent functions; two time sources (app clock, DB `now()` for audit); two schedule zones and an hour-2 rule to remember.
- **Risks**:
  - pg-boss DST cron behaviour unverified: UTC minute ticks, no hour 2, cron test.
  - Better Auth generator may emit plain `timestamp` or `now()`: schema tests cover `auth`; patch the generated file and note it in its header.
  - New code reads system time: lint rule in every package and app.
  - Clock drift on the shared, heavily loaded host: skew in `poll_run`, ops alert over 2 s.

## How we check it

- **Schema test** (real Postgres, CI): no `timestamp without time zone` columns in `app`, `auth`, `ebay_live`; `SHOW TimeZone` = `UTC`; `now()`/`CURRENT_TIMESTAMP` defaults only on allowlisted audit columns.
- **Lint**: `no-restricted-syntax`/`no-restricted-properties` reject `Date.now()` and argument-less `new Date()` outside `apps/*/src/clock.ts` and tests; `performance.now()` banned in `packages/domain`.
- **Cron test**: each registered schedule over Berlin days 2026-10-25 and 2027-03-28; minute ticks fire 1,500 and 1,380 times, wall-clock jobs exactly once per day.
- **Polling slot test**: minute-stepped clock over both nights; night feed due once per 10-min UTC slot (12 times 2026-10-25T00:00Z-02:00Z), no gap on 2027-03-28; switches to 2 min at 07:00 Berlin; same instant gives same slot.
- **DST tests**: checkpoints for an item ending 2026-10-25T01:15Z; formatter prints both 02:30s as CEST and CET; Berlin day = 25 h and 23 h.
- **Host**: `timedatectl` on intra-ai shows the clock synchronized; ops page shows the latest skew.

## Revisit when

- The cron test shows pg-boss handles hour 2 safely, a pg-boss release changes cron or `tz`, or pg-boss is replaced.
- Users work from more than one time zone, or a marketplace other than EBAY_DE is added.
- Node LTS ships `Temporal`, or Drizzle 1.0 changes timestamp defaults.
