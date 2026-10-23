import type { DbPool, Queryable } from "@ebay-sniper/db";
import { startOfBerlinDay, type ConditionGroup, type MarketValueRef } from "@ebay-sniper/domain";

// The reads of the product pages that no store covers. All run as role web (spec 2.10).

// What the products list shows per product key: "2 / 10" and the last deal.
export type ProductActivity = { candidatesToday: number; lastDealAt: Date | null };

// candidate.segment and alert.segment hold the product key (spec 2.13).
export async function productActivity(db: Queryable, at: Date): Promise<Map<string, ProductActivity>> {
  const [candidates, alerts] = await Promise.all([
    db.query<{ segment: string; n: number }>(
      "SELECT segment, count(*)::int AS n FROM app.candidate WHERE created_at >= $1 GROUP BY segment",
      [startOfBerlinDay(at)],
    ),
    db.query<{ segment: string; at: Date }>("SELECT segment, max(created_at) AS at FROM app.alert GROUP BY segment"),
  ]);
  const activity = new Map<string, ProductActivity>();
  const of = (key: string): ProductActivity => {
    const found = activity.get(key) ?? { candidatesToday: 0, lastDealAt: null };
    activity.set(key, found);
    return found;
  };
  for (const row of candidates.rows) of(row.segment).candidatesToday = row.n;
  for (const row of alerts.rows) of(row.segment).lastDealAt = row.at;
  return activity;
}

// One row of the Deals tab: a candidate that was alerted, held or found to be the wrong product.
export type ProductDeal = {
  createdAt: Date;
  decision: string;
  // Null once the listing's content is deleted (6 hours, spec 2.3).
  title: string | null;
  legacyItemId: string | null;
  landedCents: number | null;
  limitCents: number | null;
  heldReason: string | null;
  claudeReason: string | null;
};

// The decisions the Deals tab shows and filters by (spec 8.3).
export const DEAL_FILTERS = ["alerted", "held", "wrong_product"] as const;
export type DealFilter = (typeof DEAL_FILTERS)[number];

const DEAL_ROWS = 50;

// The newest deals of one product key (candidate.segment holds it), all three decisions or one.
// Titles, item IDs and Claude's reason are read only until their content expires (spec 2.3).
export async function productDeals(db: Queryable, key: string, at: Date, show: DealFilter | null): Promise<ProductDeal[]> {
  const result = await db.query<{
    created_at: Date;
    decision: string;
    title: string | null;
    legacy_item_id: string | null;
    landed_cents: number | null;
    limit_cents: number | null;
    held_reason: string | null;
    claude_reason: string | null;
  }>(
    `SELECT c.created_at, c.decision, c.landed_cents, c.limit_cents, c.held_reason,
            CASE WHEN lc.content_expires_at > $3 THEN lc.title END AS title,
            CASE WHEN l.gone_at IS NULL AND l.content_expires_at > $3 THEN l.legacy_item_id END AS legacy_item_id,
            s.reason AS claude_reason
       FROM app.candidate c
       LEFT JOIN ebay_live.listing l ON l.id = c.listing_id
       LEFT JOIN ebay_live.listing_content lc ON lc.listing_id = c.listing_id
       LEFT JOIN LATERAL (
         SELECT st.reason FROM app.screening sc JOIN ebay_live.screening_text st ON st.screening_id = sc.id AND st.expires_at > $3
          WHERE sc.item_key = c.item_key ORDER BY sc.created_at DESC LIMIT 1
       ) s ON true
      WHERE c.segment = $1 AND c.decision = ANY($2::text[])
      ORDER BY c.created_at DESC LIMIT ${String(DEAL_ROWS)}`,
    [key, show === null ? DEAL_FILTERS : [show], at],
  );
  return result.rows.map((row) => ({
    createdAt: row.created_at,
    decision: row.decision,
    title: row.title,
    legacyItemId: row.legacy_item_id,
    landedCents: row.landed_cents,
    limitCents: row.limit_cents,
    heldReason: row.held_reason,
    claudeReason: row.claude_reason,
  }));
}

// The Filtered out tab: per outcome, the listings first seen in the last 24 hours and 7 days.
export type FilteredCount = { outcome: string; day: number; week: number };

export async function filteredCounts(db: Queryable, key: string, at: Date): Promise<FilteredCount[]> {
  const result = await db.query<FilteredCount>(
    `SELECT outcome,
            count(*) FILTER (WHERE first_seen_at > $2::timestamptz - interval '24 hours')::int AS day,
            count(*)::int AS week
       FROM app.seen_item
      WHERE segment = $1 AND outcome <> 'candidate' AND first_seen_at > $2::timestamptz - interval '7 days'
      GROUP BY outcome
      ORDER BY week DESC, day DESC, outcome`,
    [key, at],
  );
  return result.rows;
}

// A title the rules dropped, from ebay_live.classifier_sample (kept 6 hours).
export type FilteredTitle = { title: string; landedCents: number | null; reason: string | null; seenAt: Date };

export async function filteredTitles(db: Queryable, key: string, at: Date): Promise<FilteredTitle[]> {
  const result = await db.query<{ title: string; landed_cents: number | null; reason: string | null; seen_at: Date }>(
    `SELECT title, landed_cents, reason, seen_at FROM ebay_live.classifier_sample
      WHERE segment = $1 AND outcome = 'rejected' AND seen_at > $2::timestamptz - interval '6 hours' AND expires_at > $2
      ORDER BY seen_at DESC LIMIT 100`,
    [key, at],
  );
  return result.rows.map((row) => ({ title: row.title, landedCents: row.landed_cents, reason: row.reason, seenAt: row.seen_at }));
}

// One row of the History tab; `email` is set for a `user:<id>` actor (spec 2.1).
export type ProductRevision = { version: number; rules: unknown; actor: string; email: string | null; createdAt: Date };

export async function productRevisions(db: Queryable, productId: string): Promise<ProductRevision[]> {
  const result = await db.query<{ version: number; rules: unknown; actor: string; email: string | null; created_at: Date }>(
    `SELECT r.version, r.rules, r.actor, u.email, r.created_at
       FROM app.product_revision r
       LEFT JOIN auth.app_user u ON r.actor = 'user:' || u.id::text
      WHERE r.product_id = $1
      ORDER BY r.version DESC`,
    [productId],
  );
  return result.rows.map((row) => ({ version: row.version, rules: row.rules, actor: row.actor, email: row.email, createdAt: row.created_at }));
}

// A market check the worker has not finished (spec 2.4: one open request per product).
export async function marketCheckOpen(db: Queryable, productId: string): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM app.market_request WHERE product_id = $1 AND status IN ('open', 'queued', 'running')", [productId]);
  return result.rows.length > 0;
}

// One listing of the newest market check (ebay_live.market_preview, kept 6 hours).
export type CheckedListing = { legacyItemId: string; title: string; landedCents: number | null; conditionGroup: ConditionGroup | null; outcome: string };

export async function newestListings(db: Queryable, productId: string, at: Date): Promise<CheckedListing[]> {
  const result = await db.query<{ legacy_item_id: string; title: string; landed_cents: number | null; condition_group: ConditionGroup | null; outcome: string }>(
    `SELECT legacy_item_id, title, landed_cents, condition_group, outcome FROM ebay_live.market_preview
      WHERE product_id = $1 AND seen_at > $2::timestamptz - interval '6 hours'
      ORDER BY landed_cents NULLS LAST, legacy_item_id`,
    [productId, at],
  );
  return result.rows.map((row) => ({
    legacyItemId: row.legacy_item_id,
    title: row.title,
    landedCents: row.landed_cents,
    conditionGroup: row.condition_group,
    outcome: row.outcome,
  }));
}

// Spec 6.5: the values of the last 30 days for the trend line, oldest first. Values the purge
// emptied have no m and are left out.
export type TrendPoint = { conditionGroup: ConditionGroup; computedAt: Date; mCents: number; p25Cents: number | null; p75Cents: number | null };

export async function marketTrend(db: Queryable, productId: string, matchVersion: number, at: Date): Promise<TrendPoint[]> {
  const result = await db.query<{ condition_group: ConditionGroup; computed_at: Date; m_cents: number; p25_cents: number | null; p75_cents: number | null }>(
    `SELECT condition_group, computed_at, m_cents, p25_cents, p75_cents FROM app.market_value
      WHERE product_id = $1 AND match_version = $2 AND m_cents IS NOT NULL
        AND computed_at > $3::timestamptz - interval '30 days' AND computed_at <= $3
      ORDER BY computed_at, id`,
    [productId, matchVersion, at],
  );
  return result.rows.map((row) => ({
    conditionGroup: row.condition_group,
    computedAt: row.computed_at,
    mCents: row.m_cents,
    p25Cents: row.p25_cents,
    p75Cents: row.p75_cents,
  }));
}

// Spec 7.5: market check now, 5 per person per Berlin day.
export const CHECK_NOW_PER_DAY = 5;

// A check_now request for the worker; poll-tick queues it (web never touches pgboss). The
// person's requests of the Berlin day are counted under a lock on the person, so two tabs cannot
// both take the fifth. A product that is already being checked gets no second request.
export async function askMarketCheck(db: DbPool, input: { productId: string; userId: string; at: Date }): Promise<"asked" | "limit"> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('market-check-now:' || $1))", [input.userId]);
    const used = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app.market_request WHERE requested_by = $1 AND reason = 'check_now' AND requested_at >= $2",
      [input.userId, startOfBerlinDay(input.at)],
    );
    if ((used.rows[0]?.n ?? 0) >= CHECK_NOW_PER_DAY) {
      await client.query("ROLLBACK");
      return "limit";
    }
    await client.query(
      `INSERT INTO app.market_request (product_id, requested_by, reason, requested_at) VALUES ($1, $2, 'check_now', $3)
       ON CONFLICT (product_id) WHERE status IN ('open', 'queued', 'running') DO NOTHING`,
      [input.productId, input.userId, input.at],
    );
    await client.query("COMMIT");
    return "asked";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Why the newest market check stored nothing, in words for the market box.
export type RefusedCheckInfo = { at: Date; reason: string };

// The newest finished check, when the worker refused it: the newest run says whether the eBay
// budget or eBay itself stopped it; without a run the extra checks of the day were used (spec 5.4).
export async function refusedMarketCheck(db: Queryable, productId: string): Promise<RefusedCheckInfo | null> {
  const result = await db.query<{ status: string; done_at: Date; run_status: string | null }>(
    `SELECT r.status, r.done_at,
            (SELECT status FROM app.market_run WHERE product_id = r.product_id ORDER BY started_at DESC LIMIT 1) AS run_status
       FROM app.market_request r
      WHERE r.product_id = $1 AND r.status IN ('done', 'refused')
      ORDER BY r.done_at DESC LIMIT 1`,
    [productId],
  );
  const row = result.rows[0];
  if (row === undefined || row.status !== "refused") return null;
  const reason =
    row.run_status === "quota_refused" ? "daily budget reached" : row.run_status === "error" ? "eBay did not answer" : "the extra checks of the day are used";
  return { at: row.done_at, reason };
}

// What category-suggest stores in category_request.result (spec 6.6), best first.
export type CategorySuggestion = { categoryId: string; categoryName: string | null; matchCount: number };

export type CategoryRequest = { id: string; status: string; suggestions: CategorySuggestion[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The person's own request by the id the form posted back, or null.
export async function loadCategoryRequest(db: Queryable, id: string, userId: string): Promise<CategoryRequest | null> {
  if (!UUID.test(id)) return null;
  const result = await db.query<{ id: string; status: string; result: { categories?: CategorySuggestion[] } | null }>(
    "SELECT id, status, result FROM app.category_request WHERE id = $1 AND requested_by = $2",
    [id, userId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { id: row.id, status: row.status, suggestions: row.result?.categories ?? [] };
}

// An open request; poll-tick turns it into a category-suggest job (web never touches pgboss).
export async function createCategoryRequest(db: Queryable, input: { userId: string; q: string; at: Date }): Promise<CategoryRequest> {
  const result = await db.query<{ id: string }>(
    "INSERT INTO app.category_request (requested_by, q, created_at) VALUES ($1, $2, $3) RETURNING id",
    [input.userId, input.q, input.at],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("category request insert returned no id");
  return { id, status: "open", suggestions: [] };
}

// The values of one product's current match version: the newest per condition group of any
// status (what the list shows), and the newest `ok` one (what the limit uses, spec 6.4).
export type CurrentValues = { newest: MarketValueRef[]; ok: MarketValueRef[] };

type ValueRow = {
  id: string;
  product_id: string;
  condition_group: ConditionGroup;
  match_version: number;
  computed_at: Date;
  status: MarketValueRef["status"];
  capped: boolean;
  value_cents: number | null;
};

const toRef = (row: ValueRow): MarketValueRef => ({
  id: row.id,
  conditionGroup: row.condition_group,
  matchVersion: row.match_version,
  computedAt: row.computed_at,
  status: row.status,
  capped: row.capped,
  valueCents: row.value_cents,
});

// Per product id, for every product at once, of the values computed before `at`.
export async function currentMarketValues(db: Queryable, at: Date): Promise<Map<string, CurrentValues>> {
  const select = (okOnly: boolean) =>
    db.query<ValueRow>(
      `SELECT DISTINCT ON (v.product_id, v.condition_group) v.id, v.product_id, v.condition_group, v.match_version,
              v.computed_at, v.status, v.capped, v.value_cents
         FROM app.market_value v JOIN app.product p ON p.id = v.product_id AND p.match_version = v.match_version
        WHERE v.computed_at < $1${okOnly ? " AND v.status = 'ok'" : ""}
        ORDER BY v.product_id, v.condition_group, v.computed_at DESC, v.id`,
      [at],
    );
  const [newest, ok] = await Promise.all([select(false), select(true)]);
  const values = new Map<string, CurrentValues>();
  const of = (id: string): CurrentValues => {
    const found = values.get(id) ?? { newest: [], ok: [] };
    values.set(id, found);
    return found;
  };
  for (const row of newest.rows) of(row.product_id).newest.push(toRef(row));
  for (const row of ok.rows) of(row.product_id).ok.push(toRef(row));
  return values;
}
