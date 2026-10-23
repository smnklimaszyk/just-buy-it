import { loadProduct, loadSettings, okMarketValuesBetween, type StoredProduct } from "@ebay-sniper/db";
import type { JobHandler } from "@ebay-sniper/db/queue";
import { MARKET_VALUE_MAX_AGE_MS, resolveLimit, sweepSearch } from "@ebay-sniper/domain";
import { buildFeedSearch } from "@ebay-sniper/ebay";
import { conditionGroups, processPage, trackRun, type PageContext, type SearchDeps, type SearchRun } from "./poll.js";

// Spec 5.1: one sweep of a product, sort=price, its own search words and deal band (the lowest
// floor to the highest limit of its watched groups, per GB up to its largest kit), one page. It
// finds price drops of tracked listings into the band; sweeps never write price samples (sorted
// by price, they would bias the read low).
export function createSweepHandler(deps: SearchDeps): JobHandler<"sweep"> {
  return async ({ productKey }, job) => {
    const now = deps.clock.now();
    const [product, resolved] = await Promise.all([loadProduct(deps.pool, productKey), loadSettings(deps.pool, deps.settingsEnv)]);
    // Spec 9: a product gone, paused or archived (or its check or eBay source switched off) since
    // the job was queued is recorded as paused.
    const sweepable = product && product.rules.status === "active" && product.ebayEnabled && product.rules.priceDropCheck ? product : null;
    const ctx: PageContext = {
      feedId: productKey,
      source: "sweep",
      products: sweepable ? [sweepable] : [],
      lowFeedbackBelow: resolved.settings.lowFeedbackBelow,
      now,
    };
    await trackRun(
      deps,
      { kind: "sweep", feedId: productKey, segment: productKey, startedAt: now },
      { signal: job.signal, logFields: { product: productKey, kind: "sweep" } },
      sweepable && ((run) => sweepPage(deps, run, sweepable, ctx)),
    );
  };
}

async function sweepPage(deps: SearchDeps, run: SearchRun, product: StoredProduct, ctx: PageContext): Promise<void> {
  const values = await okMarketValuesBetween(deps.pool, [product.id], new Date(ctx.now.getTime() - MARKET_VALUE_MAX_AGE_MS), ctx.now);
  const limitProduct = { ...product.rules, matchVersion: product.matchVersion };
  const limits = conditionGroups(product).map((group) => resolveLimit(limitProduct, group, values.get(product.id) ?? [], ctx.now));
  const band = sweepSearch({ ...product.rules, id: product.id, key: product.key, ebayEnabled: product.ebayEnabled }, limits);
  const request = buildFeedSearch({
    q: band.q,
    categoryId: band.categoryId,
    conditionIds: band.conditionIds,
    price: { floorEur: band.floorEur, ceilingEur: band.ceilingEur },
    sort: "price",
    postalCode: deps.postalCode,
  });
  await processPage(deps, run, await run.fetch(request, "sweep"), ctx);
}
