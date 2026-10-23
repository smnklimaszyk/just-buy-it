import type { DbPool } from "@ebay-sniper/db";
import { failed, storedCallPlan, UsageError, withPool, type OpsDeps } from "./change.js";

// The searches the planner derived (spec 2.3), retired ones last, with the keys of their products.
async function listSearches(pool: DbPool, deps: OpsDeps): Promise<number> {
  const searches = await pool.query(
    `SELECT s.id, s.q, s.category_id AS "categoryId", s.condition_ids AS "conditionIds", s.floor_eur AS "floorEur",
       s.ceiling_eur AS "ceilingEur", s.day_interval_s AS "dayIntervalS", s.night_interval_s AS "nightIntervalS",
       s.enabled, s.retired_at AS "retiredAt",
       coalesce(array_agg(p.key ORDER BY p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS products
     FROM app.search s
     LEFT JOIN app.search_product sp ON sp.search_id = s.id
     LEFT JOIN app.product p ON p.id = sp.product_id
     GROUP BY s.id
     ORDER BY s.retired_at IS NOT NULL, length(s.id), s.id`,
  );
  for (const search of searches.rows) deps.out(JSON.stringify(search));
  return 0;
}

// `ops searches list`. Searches are never edited by hand: they follow the products.
export async function runSearchesCommand(args: readonly string[], deps: OpsDeps): Promise<number> {
  try {
    if (args[0] === "list" && args.length === 1) return await withPool(deps, (pool) => listSearches(pool, deps));
    throw new UsageError("usage: searches list");
  } catch (error) {
    return failed(deps, error);
  }
}

// `ops plan`: the daily call plan of the stored rows.
export async function runPlanCommand(args: readonly string[], deps: OpsDeps): Promise<number> {
  try {
    if (args.length > 0) throw new UsageError("usage: plan");
    return await withPool(deps, async (pool) => {
      deps.out(JSON.stringify(await storedCallPlan(pool, deps.loadSettingsEnv())));
      return 0;
    });
  } catch (error) {
    return failed(deps, error);
  }
}
