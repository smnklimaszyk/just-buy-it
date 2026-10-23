import type { Settings } from "../settings.js";
import { isPlanned, type PlanProduct, type PlannedSearch } from "./search-plan.js";

// Spec 5.2. The planned worst case of Browse calls a Berlin day, checked on every save.

// Owner decision 8: a runbook number, not the eBay limit of 5,000.
export const PLANNED_CALLS_CEILING = 2_500;

// Polls run at the day interval from 07:00 to 23:00 Berlin time, at the night interval otherwise.
const DAY_SECONDS = 57_600;
const NIGHT_SECONDS = 28_800;

// Code constants (ADR 0037).
export const OVERFLOW_PAGES_PER_SEARCH = 10;
export const SWEEPS_PER_PRODUCT = 24;
// getItem runs for listings with a Claude slot, plus those that pass the slot check while
// another enrich job takes the last slot (enrich concurrency 2); each is up to 3 attempts.
const GET_ITEM_SLACK = 2;
const GET_ITEM_ATTEMPTS = 3;
// One snapshot of up to 3 pages per product a night, plus a global cap of 20 extra snapshots
// a day (created, rules changed, check now, category suggestions) at up to 3 calls each.
export const MARKET_CALLS_PER_SNAPSHOT = 3;
export const EXTRA_SNAPSHOTS_PER_DAY = 20;

export type DailyCallPlan = {
  polls: number;
  overflow: number;
  sweeps: number;
  getItem: number;
  market: number;
  total: number;
  ceiling: number;
  ok: boolean;
};

export function planDailyCalls(
  searches: readonly Pick<PlannedSearch, "dayIntervalS" | "nightIntervalS">[],
  products: readonly Pick<PlanProduct, "status" | "ebayEnabled" | "priceDropCheck">[],
  settings: Pick<Settings, "claudeDailyCallLimit">,
): DailyCallPlan {
  const polls = searches.reduce(
    (sum, search) => sum + Math.ceil(DAY_SECONDS / search.dayIntervalS) + Math.ceil(NIGHT_SECONDS / search.nightIntervalS),
    0,
  );
  const overflow = OVERFLOW_PAGES_PER_SEARCH * searches.length;
  const sweeps = SWEEPS_PER_PRODUCT * products.filter((product) => isPlanned(product) && product.priceDropCheck).length;
  const getItem = (settings.claudeDailyCallLimit + GET_ITEM_SLACK) * GET_ITEM_ATTEMPTS;
  const withSnapshots = products.filter((product) => product.ebayEnabled && product.status !== "archived").length;
  const market = MARKET_CALLS_PER_SNAPSHOT * (withSnapshots + EXTRA_SNAPSHOTS_PER_DAY);
  const total = polls + overflow + sweeps + getItem + market;
  return { polls, overflow, sweeps, getItem, market, total, ceiling: PLANNED_CALLS_CEILING, ok: total <= PLANNED_CALLS_CEILING };
}
