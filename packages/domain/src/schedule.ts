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

// poll-tick runs once a minute, so a search is due a little before its interval is over.
export const DUE_SLACK_MS = 20_000;
export const BREAKER_FAILURES = 5;
export const BREAKER_PAUSE_MS = 15 * 60 * 1000;

// The breaker: when the last 5 finished-or-stale runs are all errors, the search pauses for 15
// minutes from the newest of them. Returns the end of that pause, or null.
export function breakerPauseUntil(runsNewestFirst: readonly RunRow[], now: Date): Date | null {
  const settled = runsNewestFirst.filter((r) => effectiveRunStatus(r, now) !== "running").slice(0, BREAKER_FAILURES);
  if (settled.length < BREAKER_FAILURES || settled.some((r) => effectiveRunStatus(r, now) !== "error")) return null;
  const newest = settled[0];
  if (!newest) return null;
  return new Date((newest.finishedAt ?? newest.startedAt).getTime() + BREAKER_PAUSE_MS);
}

export type PollDecision = { due: true } | { due: false; reason: "paused" | "breaker" | "running" | "interval" };

export const SWEEP_MIN_GAP_MS = 55 * 60 * 1000;
