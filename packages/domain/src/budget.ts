import type { FeedConfig, SegmentRule } from "./rules.js";

// Section 3.4. The plan must stay at or under half the Browse limit of 5,000 calls a day.
export const BROWSE_DAILY_LIMIT = 5000;
export const DAILY_CALL_PLAN_CEILING = BROWSE_DAILY_LIMIT / 2;

// Polls run at the day interval from 07:00 to 23:00 Berlin time, at the night interval otherwise.
export const DAY_START_HOUR = 7;
export const DAY_END_HOUR = 23;
const DAY_SECONDS = (DAY_END_HOUR - DAY_START_HOUR) * 3600;
const NIGHT_SECONDS = 24 * 3600 - DAY_SECONDS;

// One sweep per segment per hour, in its minute slot.
const SWEEPS_PER_SEGMENT = 24;

// getItem runs only for listings with a Claude slot: at most the daily call limit, plus the ones
// that pass the slot check while another enrich job takes the last slot (enrich concurrency 2).
// Each getItem is up to 3 attempts (A20), each reserved.
export const ENRICH_CONCURRENCY = 2;
export const GET_ITEM_MAX_ATTEMPTS = 3;

export type CallPlan = {
  polls: number;
  overflowPages: number;
  sweeps: number;
  getItem: number;
  total: number;
  ceiling: number;
  withinCeiling: boolean;
};

// Worst-case Browse calls a day, without manual calls. Every feed and segment counts, enabled or
// not, so resuming one never needs a new check.
export function planDailyCalls(
  feeds: readonly FeedConfig[],
  segments: readonly SegmentRule[],
  claudeCallLimit: number,
): CallPlan {
  const polls = feeds.reduce(
    (sum, f) => sum + Math.ceil(DAY_SECONDS / f.dayIntervalS) + Math.ceil(NIGHT_SECONDS / f.nightIntervalS),
    0,
  );
  const overflowPages = feeds.reduce((sum, f) => sum + f.overflowPagesPerDay, 0);
  const sweeps = segments.length * SWEEPS_PER_SEGMENT;
  const getItem = (claudeCallLimit + ENRICH_CONCURRENCY) * GET_ITEM_MAX_ATTEMPTS;
  const total = polls + overflowPages + sweeps + getItem;
  return {
    polls,
    overflowPages,
    sweeps,
    getItem,
    total,
    ceiling: DAILY_CALL_PLAN_CEILING,
    withinCeiling: total <= DAILY_CALL_PLAN_CEILING,
  };
}
