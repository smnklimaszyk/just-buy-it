import { listProducts, listSearches, loadSettings, recentPollRuns, recentSweepRuns, type DbPool } from "@ebay-sniper/db";
import type { JobHandler, JobQueue } from "@ebay-sniper/db/queue";
import {
  BREAKER_FAILURES,
  planProductCalls,
  productSweepDue,
  searchPollDue,
  type Clock,
  type SettingsEnv,
} from "@ebay-sniper/domain";
import type { LogFn } from "./poll.js";

export type PollTickDeps = {
  pool: DbPool;
  queue: Pick<JobQueue, "send">;
  clock: Clock;
  settingsEnv: SettingsEnv;
  // Turns open market_request and category_request rows into jobs (spec 6.3, 6.6).
  queueRequests: (now: Date) => Promise<void>;
  log: { warn: LogFn };
};

// Spec 9, every minute: turns open requests into jobs, then queues a poll for each search and a
// sweep for each product that is due. The poll and sweep queues are exclusive per search id and
// product key, so one whose job is still queued or running gets no second one.
export function createPollTickHandler(deps: PollTickDeps): JobHandler<"poll-tick"> {
  return async () => {
    const now = deps.clock.now();
    // Market calls reserve with their own p_min_left and daily slots (spec 5.4), so requests are
    // not held back by the poll plan.
    await deps.queueRequests(now);
    const [searches, products, resolved] = await Promise.all([
      listSearches(deps.pool),
      listProducts(deps.pool),
      loadSettings(deps.pool, deps.settingsEnv),
    ]);
    // Spec 5.3: the backstop for rows written past the save check. While the stored plan is over
    // the ceiling, no poll or sweep is queued.
    const plan = planProductCalls(
      searches,
      products.map((product) => ({ ...product.rules, ebayEnabled: product.ebayEnabled })),
      resolved.settings,
    );
    if (!plan.ok) {
      deps.log.warn({
        event: "call_plan_refused",
        total: plan.total,
        ceiling: plan.ceiling,
        polls: plan.polls,
        overflow: plan.overflow,
        sweeps: plan.sweeps,
        get_item: plan.getItem,
        market: plan.market,
      });
      return;
    }
    for (const search of searches) {
      const runs = await recentPollRuns(deps.pool, search.id, BREAKER_FAILURES + 1);
      if (searchPollDue(search, runs, now).due) await deps.queue.send("poll", { searchId: search.id });
    }
    // Spec 5.1: the sweep stays per product, hourly in its own minute.
    for (const product of products) {
      const sweep = { ...product.rules, ebayEnabled: product.ebayEnabled, sweepMinute: product.sweepMinute };
      if (sweep.status !== "active" || !sweep.priceDropCheck) continue;
      const runs = await recentSweepRuns(deps.pool, product.key, 1);
      if (productSweepDue(sweep, runs, now).due) await deps.queue.send("sweep", { productKey: product.key });
    }
  };
}
