import { listFeeds, listSegmentRules } from "@ebay-sniper/db";
import type { JobHandler } from "@ebay-sniper/db/queue";
import { sweepBand } from "@ebay-sniper/domain";
import { buildFeedSearch } from "@ebay-sniper/ebay";
import { processPage, rulesBySegment, trackRun, type PageContext, type SearchDeps } from "./poll.js";

// Section 3.2: one sweep of a segment, sort=price, the segment's own q and deal band, one page.
// It finds price drops of tracked listings into the band; sweeps never write price samples
// (sorted by price, they would bias the read low).
export function createSweepHandler(deps: SearchDeps): JobHandler<"sweep"> {
  return async ({ segment }, job) => {
    const now = deps.clock.now();
    const [feeds, rules] = await Promise.all([listFeeds(deps.pool), listSegmentRules(deps.pool)]);
    const rule = rules.find((r) => r.segment === segment);
    const feed = feeds.find((f) => f.id === rule?.feedId);
    if (rule === undefined || feed === undefined) throw new Error(`segment ${segment} is not configured`);
    const logFields = { feed: feed.id, segment, kind: "sweep" };

    await trackRun(
      deps,
      { kind: "sweep", feedId: feed.id, segment, startedAt: now },
      { enabled: feed.enabled && rule.enabled, signal: job.signal, logFields },
      async (run) => {
        const ctx: PageContext = { feedId: feed.id, source: "sweep", baseline: false, rules: rulesBySegment(rules), now };
        const request = buildFeedSearch({
          q: rule.sweepQ,
          categoryId: feed.categoryId,
          conditionIds: feed.conditionIds,
          price: sweepBand(rule),
          sort: "price",
          postalCode: deps.postalCode,
        });
        await processPage(deps, run, await run.fetch(request, "sweep"), ctx);
      },
    );
  };
}
