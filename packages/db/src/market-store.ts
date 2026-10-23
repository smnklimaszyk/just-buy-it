import type {
  ConditionGroup,
  MarketListingRow,
  MarketSource,
  MarketValueRef,
  MarketValueResult,
  MarketValueStatus,
} from "@ebay-sniper/domain";
import type { Queryable } from "./pool.js";

// Spec 2.4, 5.4 and 6, ADR 0040. The market tables: listings of the product's snapshots and poll
// sightings, the computed values, the daily cap on extra snapshots and their purge. The worker
// writes them; web reads them.

// One listing as a snapshot or a poll saw it. `originAt` is itemOriginDate, else
// itemCreationDate, else null. Cents are the whole listing, also when the product prices per GB.
export type MarketSighting = {
  source: MarketSource;
  itemKey: string;
  // NULL only for an excluded listing whose condition maps to no group.
  conditionGroup: ConditionGroup | null;
  matchVersion: number;
  landedCents: number;
  unitTotal: number | null;
  originAt: Date | null;
  seenAt: Date;
  bestOffer: boolean;
  excludedReason: string | null;
};

// The incoming sighting is the newer view of the listing.
const NEWER = "(EXCLUDED.match_version > l.match_version OR EXCLUDED.last_seen_at >= l.last_seen_at)";

// One row per listing. A sighting replaces the stored price and fields when it is the newest one
// of the same match version, or of a newer match version; a sighting of an older match version
// changes nothing. The first and last sighting only ever widen.
export async function upsertMarketListings(db: Queryable, productId: string, sightings: readonly MarketSighting[]): Promise<void> {
  if (sightings.length === 0) return;
  await db.query(
    `WITH input AS (
       SELECT u.*, min(u.t) OVER (PARTITION BY u.s, u.k, u.mv) AS first_t
         FROM unnest($2::integer[], $3::text[], $4::text[], $5::text[], $6::integer[], $7::integer[], $8::timestamptz[],
                     $9::timestamptz[], $10::boolean[], $11::text[]) AS u(mv, s, k, g, lc, ut, o, t, bo, er)
     )
     INSERT INTO app.market_listing AS l (product_id, match_version, source, item_key, condition_group, landed_cents,
       unit_total, origin_at, first_seen_at, last_seen_at, best_offer, excluded_reason)
     SELECT DISTINCT ON (s, k) $1::uuid, mv, s, k, g, lc, ut, o, first_t, t, bo, er
       FROM input ORDER BY s, k, mv DESC, t DESC
     ON CONFLICT (product_id, source, item_key) DO UPDATE SET
       match_version = EXCLUDED.match_version,
       condition_group = CASE WHEN ${NEWER} THEN EXCLUDED.condition_group ELSE l.condition_group END,
       landed_cents = CASE WHEN ${NEWER} THEN EXCLUDED.landed_cents ELSE l.landed_cents END,
       unit_total = CASE WHEN ${NEWER} THEN EXCLUDED.unit_total ELSE l.unit_total END,
       origin_at = CASE WHEN ${NEWER} THEN coalesce(EXCLUDED.origin_at, l.origin_at) ELSE l.origin_at END,
       best_offer = CASE WHEN ${NEWER} THEN EXCLUDED.best_offer ELSE l.best_offer END,
       excluded_reason = CASE WHEN ${NEWER} THEN EXCLUDED.excluded_reason ELSE l.excluded_reason END,
       first_seen_at = least(l.first_seen_at, EXCLUDED.first_seen_at),
       last_seen_at = greatest(l.last_seen_at, EXCLUDED.last_seen_at)
     WHERE EXCLUDED.match_version >= l.match_version`,
    [
      productId,
      sightings.map((s) => s.matchVersion),
      sightings.map((s) => s.source),
      sightings.map((s) => s.itemKey),
      sightings.map((s) => s.conditionGroup),
      sightings.map((s) => s.landedCents),
      sightings.map((s) => s.unitTotal),
      sightings.map((s) => s.originAt),
      sightings.map((s) => s.seenAt),
      sightings.map((s) => s.bestOffer),
      sightings.map((s) => s.excludedReason),
    ],
  );
}

// Spec 6.2: the pool of a run at `at` is the listings last seen in the 30 days before it. All
// groups, sources and match versions; computeMarketValue picks its own.
export async function loadMarketPool(db: Queryable, productId: string, at: Date): Promise<MarketListingRow[]> {
  const result = await db.query<{
    item_key: string;
    source: MarketSource;
    condition_group: ConditionGroup | null;
    match_version: number;
    landed_cents: number;
    unit_total: number | null;
    origin_at: Date | null;
    first_seen_at: Date;
    last_seen_at: Date;
    best_offer: boolean;
    excluded_reason: string | null;
  }>(
    `SELECT item_key, source, condition_group, match_version, landed_cents, unit_total, origin_at, first_seen_at,
            last_seen_at, best_offer, excluded_reason
       FROM app.market_listing
      WHERE product_id = $1 AND last_seen_at >= $2::timestamptz - interval '30 days'`,
    [productId, at],
  );
  return result.rows.map((row) => ({
    itemKey: row.item_key,
    source: row.source,
    conditionGroup: row.condition_group,
    matchVersion: row.match_version,
    landedCents: row.landed_cents,
    unitTotal: row.unit_total,
    originAt: row.origin_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    bestOffer: row.best_offer,
    excludedReason: row.excluded_reason,
  }));
}

// Spec 6.1: listings Claude called wrong_product leave the pool by item key. candidate.segment
// holds the product key.
export async function wrongProductItemKeys(db: Queryable, productId: string): Promise<Set<string>> {
  const result = await db.query<{ item_key: string }>(
    `SELECT c.item_key FROM app.candidate c JOIN app.product p ON p.key = c.segment
      WHERE p.id = $1 AND c.decision = 'wrong_product'`,
    [productId],
  );
  return new Set(result.rows.map((row) => row.item_key));
}

export type MarketValueStoreResult =
  | { ok: true; values: MarketValueRef[] }
  // The product's match version is no longer the one the values were computed for (spec 6.3).
  | { ok: false; reason: "match_version_changed" };

// Spec 6.3: the values of one snapshot, one per watched condition group, in the order given. They
// are stored only while the product's match version is still theirs, checked in the same
// statement. A save that commits after it bumps the version, so the stored rows are never read.
export async function storeMarketValues(
  db: Queryable,
  productId: string,
  results: readonly MarketValueResult[],
): Promise<MarketValueStoreResult> {
  if (results.length === 0) return { ok: true, values: [] };
  const inserted = await db.query<ValueRefRow>(
    `INSERT INTO app.market_value (product_id, condition_group, match_version, computed_at, method_version, status, capped,
       n, neff, m_cents, p25_cents, p75_cents, lo_cents, hi_cents, half_width, best_offer_share, value_cents, counts)
     SELECT $1::uuid, u.*
       FROM unnest($2::text[], $3::integer[], $4::timestamptz[], $5::text[], $6::text[], $7::boolean[], $8::integer[],
                   $9::numeric[], $10::integer[], $11::integer[], $12::integer[], $13::integer[], $14::integer[],
                   $15::numeric[], $16::numeric[], $17::integer[], $18::jsonb[])
            AS u(g, mv, ca, mt, st, cp, n, neff, m, p25, p75, lo, hi, hw, bo, v, c)
      WHERE EXISTS (SELECT 1 FROM app.product p WHERE p.id = $1::uuid AND p.match_version = u.mv)
     RETURNING ${VALUE_REF_COLUMNS}`,
    [
      productId,
      results.map((r) => r.conditionGroup),
      results.map((r) => r.matchVersion),
      results.map((r) => r.computedAt),
      results.map((r) => r.methodVersion),
      results.map((r) => r.status),
      results.map((r) => r.capped),
      results.map((r) => r.n),
      results.map((r) => r.neff),
      results.map((r) => r.mCents),
      results.map((r) => r.p25Cents),
      results.map((r) => r.p75Cents),
      results.map((r) => r.loCents),
      results.map((r) => r.hiCents),
      results.map((r) => r.halfWidth),
      results.map((r) => r.bestOfferShare),
      results.map((r) => r.valueCents),
      results.map((r) => JSON.stringify(r.counts)),
    ],
  );
  if (inserted.rows.length === 0) return { ok: false, reason: "match_version_changed" };
  const order = results.map((r) => r.conditionGroup);
  return {
    ok: true,
    values: inserted.rows.map(toValueRef).sort((a, b) => order.indexOf(a.conditionGroup) - order.indexOf(b.conditionGroup)),
  };
}

// Spec 6.4: per condition group the newest `ok` value of the match version computed before `at`,
// ordered by group. resolveLimit takes these and applies the 7-day limit itself; `at` is the
// listing's first sighting.
export async function newestOkMarketValues(
  db: Queryable,
  productId: string,
  matchVersion: number,
  at: Date,
): Promise<MarketValueRef[]> {
  const result = await db.query<ValueRefRow>(
    `SELECT DISTINCT ON (condition_group) ${VALUE_REF_COLUMNS}
       FROM app.market_value
      WHERE product_id = $1 AND match_version = $2 AND status = 'ok' AND value_cents IS NOT NULL AND computed_at < $3
      ORDER BY condition_group, computed_at DESC, id`,
    [productId, matchVersion, at],
  );
  return result.rows.map(toValueRef);
}

// An app.market_value row in full, for the product page (spec 6.5). The method version is the
// one it was computed with.
export type StoredMarketValue = Omit<MarketValueResult, "methodVersion"> & { id: string; methodVersion: string };

// The newest value of each condition group of the match version, whatever its status, ordered by
// group. "Out of date" is worked out by the reader (isOutOfDate).
export async function newestMarketValues(db: Queryable, productId: string, matchVersion: number): Promise<StoredMarketValue[]> {
  const result = await db.query<{
    id: string;
    condition_group: ConditionGroup;
    match_version: number;
    computed_at: Date;
    method_version: string;
    status: MarketValueStatus;
    capped: boolean;
    n: number;
    neff: string;
    m_cents: number | null;
    p25_cents: number | null;
    p75_cents: number | null;
    lo_cents: number | null;
    hi_cents: number | null;
    half_width: string | null;
    best_offer_share: string | null;
    value_cents: number | null;
    counts: Record<string, number>;
  }>(
    `SELECT DISTINCT ON (condition_group) id, condition_group, match_version, computed_at, method_version, status, capped, n,
            neff, m_cents, p25_cents, p75_cents, lo_cents, hi_cents, half_width, best_offer_share, value_cents, counts
       FROM app.market_value
      WHERE product_id = $1 AND match_version = $2
      ORDER BY condition_group, computed_at DESC, id`,
    [productId, matchVersion],
  );
  return result.rows.map((row) => ({
    id: row.id,
    methodVersion: row.method_version,
    conditionGroup: row.condition_group,
    matchVersion: row.match_version,
    computedAt: row.computed_at,
    status: row.status,
    capped: row.capped,
    n: row.n,
    neff: Number(row.neff),
    mCents: row.m_cents,
    p25Cents: row.p25_cents,
    p75Cents: row.p75_cents,
    loCents: row.lo_cents,
    hiCents: row.hi_cents,
    halfWidth: row.half_width === null ? null : Number(row.half_width),
    bestOfferShare: row.best_offer_share === null ? null : Number(row.best_offer_share),
    valueCents: row.value_cents,
    counts: row.counts,
  }));
}

// Spec 5.4: snapshots outside the nightly run (created, rules changed, check now) share 20 a
// Berlin day across all products.
export const MARKET_EXTRA_SNAPSHOTS_PER_DAY = 20;

// Takes one slot of the Berlin day of `at` before the first eBay call, or returns false when the
// day's slots are used. One statement: parallel callers never get more than the limit.
export async function takeExtraSnapshotSlot(db: Queryable, at: Date): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO app.market_daily AS d (day_berlin, extra_snapshots)
     VALUES (($1::timestamptz AT TIME ZONE 'Europe/Berlin')::date, 1)
     ON CONFLICT (day_berlin) DO UPDATE SET extra_snapshots = d.extra_snapshots + 1
     WHERE d.extra_snapshots < $2
     RETURNING extra_snapshots`,
    [at, MARKET_EXTRA_SNAPSHOTS_PER_DAY],
  );
  return result.rowCount === 1;
}

// One purge statement in the form runPurge runs it: $1 is the batch size, the statement changes at
// most that many rows and its condition stops matching a row once it changed it. runPurge repeats
// it until a batch is not full.
export type MarketPurgeStep = { name: string; statement: string; params: (now: Date) => unknown[] };

const deleteBatch = (table: string, condition: string): string =>
  `DELETE FROM ${table} WHERE ctid = ANY (ARRAY(SELECT ctid FROM ${table} WHERE ${condition} LIMIT $1))`;

const MARKET_VALUE_PRICES = ["m_cents", "p25_cents", "p75_cents", "lo_cents", "hi_cents", "value_cents"];

// Spec 2.4 lifetimes, all against the purge's `now` ($2). market_daily is kept (one row a day).
// Requests go after 7 days whatever their status, so a request left running by a crash cannot
// block its product's next one for longer.
export const MARKET_PURGE_STEPS: readonly MarketPurgeStep[] = [
  {
    name: "market_preview",
    statement: deleteBatch("ebay_live.market_preview", "seen_at <= $2::timestamptz - interval '6 hours'"),
    params: (now) => [now],
  },
  {
    name: "market_listing",
    statement: deleteBatch("app.market_listing", "last_seen_at <= $2::timestamptz - interval '30 days'"),
    params: (now) => [now],
  },
  {
    name: "market_value",
    statement: deleteBatch("app.market_value", "computed_at <= $2::timestamptz - interval '1 year'"),
    params: (now) => [now],
  },
  {
    name: "market_value_prices",
    statement: `UPDATE app.market_value SET ${MARKET_VALUE_PRICES.map((column) => `${column} = NULL`).join(", ")}
      WHERE ctid = ANY (ARRAY(SELECT ctid FROM app.market_value
        WHERE computed_at <= $2::timestamptz - interval '30 days'
          AND (${MARKET_VALUE_PRICES.map((column) => `${column} IS NOT NULL`).join(" OR ")}) LIMIT $1))`,
    params: (now) => [now],
  },
  {
    name: "market_request",
    statement: deleteBatch("app.market_request", "requested_at <= $2::timestamptz - interval '7 days'"),
    params: (now) => [now],
  },
  {
    name: "category_request",
    statement: deleteBatch("app.category_request", "created_at <= $2::timestamptz - interval '7 days'"),
    params: (now) => [now],
  },
  {
    name: "market_run",
    statement: deleteBatch("app.market_run", "started_at <= $2::timestamptz - interval '30 days'"),
    params: (now) => [now],
  },
];

const VALUE_REF_COLUMNS = "id, condition_group, match_version, computed_at, status, capped, value_cents";

type ValueRefRow = {
  id: string;
  condition_group: ConditionGroup;
  match_version: number;
  computed_at: Date;
  status: MarketValueStatus;
  capped: boolean;
  value_cents: number | null;
};

const toValueRef = (row: ValueRefRow): MarketValueRef => ({
  id: row.id,
  conditionGroup: row.condition_group,
  matchVersion: row.match_version,
  computedAt: row.computed_at,
  status: row.status,
  capped: row.capped,
  valueCents: row.value_cents,
});
