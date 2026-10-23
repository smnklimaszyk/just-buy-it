import { listProducts, type DbPool } from "@ebay-sniper/db";
import type { JobHandler, JobQueue } from "@ebay-sniper/db/queue";
import type { LogFn } from "./poll.js";

export type MarketNightlyDeps = {
  pool: DbPool;
  queue: Pick<JobQueue, "send">;
  log: { info: LogFn };
};

// Spec 6.3: once a night, one market-snapshot job per non-archived product with an eBay source,
// drafts and paused products included (the plan's market line counts them). The snapshot queue
// works one job at a time, so the snapshots run one after another. A product whose snapshot is
// still queued or running gets no second job.
export function createMarketNightlyHandler(deps: MarketNightlyDeps): JobHandler<"market-nightly"> {
  return async () => {
    const products = (await listProducts(deps.pool)).filter(
      (product) => product.rules.status !== "archived" && product.ebayEnabled,
    );
    let queued = 0;
    for (const product of products) {
      if ((await deps.queue.send("market-snapshot", { productId: product.id })) !== null) queued += 1;
    }
    deps.log.info({ event: "market_nightly", products: products.length, queued });
  };
}
