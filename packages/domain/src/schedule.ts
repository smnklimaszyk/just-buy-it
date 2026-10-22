import { DAY_END_HOUR, DAY_START_HOUR } from "./budget.js";
import type { FeedConfig, SegmentRule } from "./rules.js";
import { segmentInfo } from "./segments.js";
import { berlinWallTime } from "./time.js";

export type RunStatus = "running" | "ok" | "error" | "quota_refused" | "paused";

// The fields of an app.poll_run row the due rules read.
export type RunRow = { status: RunStatus; startedAt: Date; finishedAt: Date | null };

// A running row older than this is stale: the handler crashed. It is above the poll's
// expireInSeconds (150 s), so a live handler is never taken for a crashed one.
export const STALE_RUN_AFTER_MS = 5 * 60 * 1000;

// A stale running row counts as error for the due rule and the breaker.
export function effectiveRunStatus(run: RunRow, now: Date): RunStatus {
  if (run.status === "running" && now.getTime() - run.startedAt.getTime() > STALE_RUN_AFTER_MS) return "error";
  return run.status;
}

// Day interval from 07:00 to 23:00 Europe/Berlin, night interval otherwise.
export function pollIntervalSeconds(feed: FeedConfig, now: Date): number {
  const hour = berlinWallTime(now).hour;
  return hour >= DAY_START_HOUR && hour < DAY_END_HOUR ? feed.dayIntervalS : feed.nightIntervalS;
}

// poll-tick runs once a minute, so a feed is due a little before its interval is over.
export const DUE_SLACK_MS = 20_000;
export const BREAKER_FAILURES = 5;
export const BREAKER_PAUSE_MS = 15 * 60 * 1000;

// The breaker: when the last 5 finished-or-stale runs are all errors, the feed pauses for 15
// minutes from the newest of them. Returns the end of that pause, or null.
export function breakerPauseUntil(runsNewestFirst: readonly RunRow[], now: Date): Date | null {
  const settled = runsNewestFirst.filter((r) => effectiveRunStatus(r, now) !== "running").slice(0, BREAKER_FAILURES);
  if (settled.length < BREAKER_FAILURES || settled.some((r) => effectiveRunStatus(r, now) !== "error")) return null;
  const newest = settled[0];
  if (!newest) return null;
  return new Date((newest.finishedAt ?? newest.startedAt).getTime() + BREAKER_PAUSE_MS);
}

export type PollDecision = { due: true } | { due: false; reason: "paused" | "breaker" | "running" | "interval" };

// Section 2.3 due rule for a feed's poll. runsNewestFirst are its latest poll runs (at least 5).
export function pollDue(feed: FeedConfig, runsNewestFirst: readonly RunRow[], now: Date): PollDecision {
  if (!feed.enabled) return { due: false, reason: "paused" };
  const newest = runsNewestFirst[0];
  if (newest && effectiveRunStatus(newest, now) === "running") return { due: false, reason: "running" };
  const pauseUntil = breakerPauseUntil(runsNewestFirst, now);
  if (pauseUntil && pauseUntil.getTime() > now.getTime()) return { due: false, reason: "breaker" };
  const waitMs = pollIntervalSeconds(feed, now) * 1000 - DUE_SLACK_MS;
  if (newest && now.getTime() - newest.startedAt.getTime() < waitMs) return { due: false, reason: "interval" };
  return { due: true };
}

export const SWEEP_MIN_GAP_MS = 55 * 60 * 1000;

export type SweepDecision =
  | { due: true }
  | { due: false; reason: "paused" | "baseline" | "slot" | "running" | "interval" };

// Section 2.3 due rule for a segment's sweep: only in its minute slot, after the feed's baseline
// poll finished ok, and at least 55 minutes after the last sweep started. Berlin offsets are whole
// hours, so the UTC minute is the Berlin minute.
export function sweepDue(
  feed: FeedConfig,
  rule: SegmentRule,
  baselineDone: boolean,
  runsNewestFirst: readonly RunRow[],
  now: Date,
): SweepDecision {
  if (!feed.enabled || !rule.enabled) return { due: false, reason: "paused" };
  if (!baselineDone) return { due: false, reason: "baseline" };
  if (now.getUTCMinutes() !== segmentInfo(rule.segment).sweepMinute) return { due: false, reason: "slot" };
  const newest = runsNewestFirst[0];
  if (newest && effectiveRunStatus(newest, now) === "running") return { due: false, reason: "running" };
  if (newest && now.getTime() - newest.startedAt.getTime() < SWEEP_MIN_GAP_MS) return { due: false, reason: "interval" };
  return { due: true };
}
