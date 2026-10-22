import { feedHasSeenItems, listFeeds, listSegmentRules, recentPollRuns, recentSweepRuns, type DbPool } from "@ebay-sniper/db";
import type { JobHandler, JobQueue } from "@ebay-sniper/db/queue";
import { BREAKER_FAILURES, planDailyCalls, pollDue, sweepDue, type Clock, type FeedId } from "@ebay-sniper/domain";
import type { LogFn } from "./poll.js";

export type PollTickDeps = {
  pool: DbPool;
  queue: Pick<JobQueue, "send">;
  clock: Clock;
  claudeCallLimit: number;
  log: { warn: LogFn };
};

// Section 2.3, every minute: queues a poll for each feed and a sweep for each segment that is due.
// The poll and sweep queues are exclusive per key, so a feed or segment whose job is still queued
// or running gets no second one.
export function createPollTickHandler(deps: PollTickDeps): JobHandler<"poll-tick"> {
  return async () => {
    const now = deps.clock.now();
    const [feeds, rules] = await Promise.all([listFeeds(deps.pool), listSegmentRules(deps.pool)]);
    // Section 3.4: the worker refuses to schedule polls while the worst-case plan breaks the ceiling.
    const plan = planDailyCalls(feeds, rules, deps.claudeCallLimit);
    if (!plan.withinCeiling) {
      deps.log.warn({
        event: "call_plan_refused",
        total: plan.total,
        ceiling: plan.ceiling,
        polls: plan.polls,
        overflow_pages: plan.overflowPages,
        sweeps: plan.sweeps,
        get_item: plan.getItem,
      });
      return;
    }
    for (const feed of feeds) {
      const runs = await recentPollRuns(deps.pool, feed.id, BREAKER_FAILURES + 1);
      if (pollDue(feed, runs, now).due) await deps.queue.send("poll", { feedId: feed.id });
    }
    // A feed's baseline is done once its baseline poll committed seen_item rows (section 3.2).
    const baselineDone = new Map<FeedId, boolean>();
    for (const rule of rules) {
      const feed = feeds.find((f) => f.id === rule.feedId);
      if (feed === undefined) continue;
      const done = baselineDone.get(feed.id) ?? (await feedHasSeenItems(deps.pool, feed.id));
      baselineDone.set(feed.id, done);
      const runs = await recentSweepRuns(deps.pool, rule.segment, 1);
      if (sweepDue(feed, rule, done, runs, now).due) await deps.queue.send("sweep", { segment: rule.segment });
    }
  };
}
