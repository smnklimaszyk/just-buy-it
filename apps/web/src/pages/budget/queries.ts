import { listProducts, loadSettings, type Queryable } from "@ebay-sniper/db";
import { berlinDay, planProductCalls, type DailyCallPlan, type SettingsEnv } from "@ebay-sniper/domain";

// The reads of the budget page. All run as role web (spec 2.10).

// One live search as the budget page lists it.
export type SearchListing = {
  id: string;
  q: string;
  categoryId: string;
  // From its products; null until a market snapshot or the form stored one.
  categoryName: string | null;
  dayIntervalS: number;
  nightIntervalS: number;
  products: string[];
  lastPollAt: Date | null;
};

// The searches the planner keeps live, by id number, with their products' names and last poll
// (poll_run.feed_id holds the search id).
export async function liveSearches(db: Queryable): Promise<SearchListing[]> {
  const result = await db.query<{
    id: string;
    q: string;
    category_id: string;
    category_name: string | null;
    day_interval_s: number;
    night_interval_s: number;
    products: string[];
    last_poll_at: Date | null;
  }>(
    `SELECT s.id, s.q, s.category_id, s.day_interval_s, s.night_interval_s,
       max(p.category_name) AS category_name,
       coalesce(array_agg(p.name ORDER BY p.name) FILTER (WHERE p.name IS NOT NULL), '{}') AS products,
       (SELECT max(r.started_at) FROM app.poll_run r WHERE r.feed_id = s.id AND r.kind = 'poll') AS last_poll_at
     FROM app.search s
       LEFT JOIN app.search_product sp ON sp.search_id = s.id
       LEFT JOIN app.product p ON p.id = sp.product_id
     WHERE s.retired_at IS NULL
     GROUP BY s.id
     ORDER BY length(s.id), s.id`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    q: row.q,
    categoryId: row.category_id,
    categoryName: row.category_name,
    dayIntervalS: row.day_interval_s,
    nightIntervalS: row.night_interval_s,
    products: row.products,
    lastPollAt: row.last_poll_at,
  }));
}

// The Browse calls reserved in the quota window that holds `at`; 0 before the first call of it.
export async function quotaUsed(db: Queryable, at: Date): Promise<number> {
  const result = await db.query<{ used: number }>(
    "SELECT used FROM app.ebay_quota_window WHERE resource = 'buy.browse' AND window_start <= $1 AND $1 < window_end",
    [at],
  );
  return result.rows[0]?.used ?? 0;
}

// Claude calls of one product key on one Berlin day (spec 4.4). name is null for a key no
// product has.
export type ProductCalls = { key: string; name: string | null; calls: number };

export async function claudeCallsToday(db: Queryable, at: Date): Promise<ProductCalls[]> {
  const result = await db.query<ProductCalls>(
    `SELECT u.product_key AS key, p.name, u.calls
     FROM app.llm_usage_product_daily u LEFT JOIN app.product p ON p.key = u.product_key
     WHERE u.day_berlin = $1 AND u.calls > 0
     ORDER BY u.calls DESC, u.product_key`,
    [berlinDay(at)],
  );
  return result.rows;
}

// Spec 5.2: the worst-case Browse calls a day of the stored searches and products, with the
// Claude call limit in force. Every save rebuilds the searches, so the live rows are the planner's
// searches (the same reading as `ops plan`).
export async function storedCallPlan(db: Queryable, env: SettingsEnv): Promise<DailyCallPlan> {
  const [searches, products, { settings }] = await Promise.all([
    db.query<{ day_interval_s: number; night_interval_s: number }>("SELECT day_interval_s, night_interval_s FROM app.search WHERE retired_at IS NULL"),
    listProducts(db),
    loadSettings(db, env),
  ]);
  return planProductCalls(
    searches.rows.map((row) => ({ dayIntervalS: row.day_interval_s, nightIntervalS: row.night_interval_s })),
    products.map(({ ebayEnabled, rules }) => ({ status: rules.status, ebayEnabled, priceDropCheck: rules.priceDropCheck })),
    settings,
  );
}
