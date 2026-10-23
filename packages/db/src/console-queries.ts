import { berlinDay, effectiveRunStatus, startOfBerlinDay, type PriceMode, type RunStatus, type Verdict } from "@ebay-sniper/domain";
import type { Queryable } from "./pool.js";
import { getWorkerStatus, type WorkerStatus } from "./worker-status.js";

// Spec 8.3 and 11.2 V6c: the reads of the overview and the deals page of the admin UI. They run as
// role web (spec 2.10). candidate.segment and alert.segment hold the product key (spec 2.13).

// `from`: "candidate" is candidate.limit_cents (spec 2.8), "revision" the max_cents of the
// product revision the candidate passed.
export type DealLimit = { cents: number; perGb: boolean; from: "candidate" | "revision" };

// One alert, or one candidate held or found to be the wrong product.
export type Deal = {
  candidateId: string;
  createdAt: Date;
  // When the alert was made; null for a held or wrong-product candidate.
  alertedAt: Date | null;
  productKey: string;
  // null for a key no product has (rows written before the import); the page shows the key.
  productName: string | null;
  decision: string;
  // Why a held candidate was held (the Claude check could not run), else null.
  heldReason: string | null;
  // Title and item ID only until the listing content expires (6 hours) or the listing is gone.
  title: string | null;
  legacyItemId: string | null;
  // NULL after 30 days (purge).
  priceCents: number | null;
  shippingCents: number | null;
  landedCents: number | null;
  // Products priced per GB only.
  totalGb: number | null;
  // The limit the candidate passed, per GB when the product prices per GB.
  limit: DealLimit | null;
  // The price against the limit as a whole percentage; with shipping unknown the item price alone,
  // as in the price rules and the email.
  percentOfLimit: number | null;
  // null on rows written before v2.
  priceMode: PriceMode | null;
  // Market mode without a usable market value: the cap applied ("using your cap", spec 6.4).
  usingCap: boolean;
  // The typical asking price the limit came from, and how far below it the price is. Its price is
  // NULL after 30 days (purge), and then there is no line.
  marketValue: { cents: number; computedAt: Date; percentBelow: number | null } | null;
  // The alert's verdict (screened false: "Not checked by Claude"); null without an alert.
  verdict: { screened: boolean; finalVerdict: Verdict; blockedByCode: boolean } | null;
  // From the newest finished Claude check of the listing, the reason only while its text is kept.
  productMatch: string | null;
  claudeReason: string | null;
};

type DealDb = {
  id: string;
  created_at: Date;
  alerted_at: Date | null;
  segment: string;
  name: string | null;
  decision: string;
  held_reason: string | null;
  title: string | null;
  legacy_item_id: string | null;
  price_cents: number | null;
  shipping_cents: number | null;
  landed_cents: number | null;
  total_gb: number | null;
  limit_cents: number | null;
  revision_max_cents: number | null;
  per_gb: boolean | null;
  price_mode: PriceMode | null;
  market_value_id: string | null;
  market_value_cents: number | null;
  market_computed_at: Date | null;
  screened: boolean | null;
  final_verdict: Verdict | null;
  blocked_by_code: boolean | null;
  product_match: string | null;
  claude_reason: string | null;
};

const DEAL_SELECT = `SELECT c.id, c.created_at, a.created_at AS alerted_at, c.segment, p.name, c.decision, c.held_reason,
       c.price_cents, c.shipping_cents, c.landed_cents, c.total_gb, c.limit_cents,
       (r.rules->>'maxCents')::int AS revision_max_cents, coalesce((r.rules->>'perGb')::boolean, p.per_gb) AS per_gb,
       c.price_mode, c.market_value_id, mv.value_cents AS market_value_cents, mv.computed_at AS market_computed_at,
       CASE WHEN lc.content_expires_at > $1 THEN lc.title END AS title,
       CASE WHEN l.gone_at IS NULL AND l.content_expires_at > $1 THEN l.legacy_item_id END AS legacy_item_id,
       a.screened, a.final_verdict, a.blocked_by_code, s.product_match, s.reason AS claude_reason
  FROM app.candidate c
  LEFT JOIN app.product p ON p.key = c.segment
  LEFT JOIN LATERAL (
    SELECT x.rules FROM app.product_revision x
     WHERE x.product_id = p.id AND (
       x.version = c.product_version
       OR (c.product_version IS NULL AND x.version = 1 AND x.actor = 'system:import' AND EXISTS (
         SELECT 1 FROM app.audit_event e CROSS JOIN LATERAL jsonb_array_elements(e.detail->'products') imported
          WHERE e.action = 'import.legacy_products' AND imported->>'key' = c.segment
            AND imported->>'rule_version' = c.rule_version::text)))
     LIMIT 1
  ) r ON true
  LEFT JOIN app.market_value mv ON mv.id = c.market_value_id
  LEFT JOIN ebay_live.listing l ON l.id = c.listing_id
  LEFT JOIN ebay_live.listing_content lc ON lc.listing_id = c.listing_id
  LEFT JOIN LATERAL (
    SELECT x.created_at, x.screened, x.final_verdict, x.blocked_by_code FROM app.alert x
     WHERE x.candidate_id = c.id ORDER BY x.created_at DESC LIMIT 1
  ) a ON true
  LEFT JOIN LATERAL (
    SELECT sc.product_match, st.reason FROM app.screening sc
      LEFT JOIN ebay_live.screening_text st ON st.screening_id = sc.id AND st.expires_at > $1
     WHERE sc.item_key = c.item_key AND sc.status = 'done' ORDER BY sc.created_at DESC LIMIT 1
  ) s ON true`;

// Rows written before v2 stored no limit: the max of the product revision they passed stands in.
// A Release 0 row has no product version; the import's revision (version 1) holds the segment
// rule the import copied, so it stands in only for rows that passed that rule version (the import
// audit row lists it per key). Older rule versions have no revision and get no percentage.
function limitOf(row: DealDb): DealLimit | null {
  const perGb = row.per_gb === true;
  if (row.limit_cents !== null) return { cents: row.limit_cents, perGb, from: "candidate" };
  if (row.revision_max_cents !== null) return { cents: row.revision_max_cents, perGb, from: "revision" };
  return null;
}

// The price as a whole percentage of `cents`; per GB of `cents` times the total, and without a
// total there is no percentage.
function percentOf(row: DealDb, cents: number, perGb: boolean): number | null {
  const basis = row.landed_cents ?? row.price_cents;
  const units = perGb ? row.total_gb : 1;
  if (basis === null || units === null || units <= 0) return null;
  return Math.round((100 * basis) / (cents * units));
}

// How far below the market value the price is, per GB like the limit.
function marketValueOf(row: DealDb): Deal["marketValue"] {
  if (row.market_value_cents === null || row.market_computed_at === null) return null;
  const share = percentOf(row, row.market_value_cents, row.per_gb === true);
  return { cents: row.market_value_cents, computedAt: row.market_computed_at, percentBelow: share === null ? null : 100 - share };
}

function toDeal(row: DealDb): Deal {
  const limit = limitOf(row);
  return {
    candidateId: row.id,
    createdAt: row.created_at,
    alertedAt: row.alerted_at,
    productKey: row.segment,
    productName: row.name,
    decision: row.decision,
    heldReason: row.held_reason,
    title: row.title,
    legacyItemId: row.legacy_item_id,
    priceCents: row.price_cents,
    shippingCents: row.shipping_cents,
    landedCents: row.landed_cents,
    totalGb: row.total_gb,
    limit,
    percentOfLimit: limit === null ? null : percentOf(row, limit.cents, limit.perGb),
    priceMode: row.price_mode,
    usingCap: row.price_mode === "below_market" && row.market_value_id === null,
    marketValue: marketValueOf(row),
    verdict:
      row.final_verdict === null
        ? null
        : { screened: row.screened === true, finalVerdict: row.final_verdict, blockedByCode: row.blocked_by_code === true },
    productMatch: row.product_match,
    claudeReason: row.claude_reason,
  };
}

// The overview leads with these: alerts of the last 24 hours whose listing is not known to be
// gone, newest first.
const OPEN_DEALS_MAX = 50;

export async function openDeals(db: Queryable, now: Date): Promise<Deal[]> {
  const result = await db.query<DealDb>(
    `${DEAL_SELECT}
      WHERE c.decision = 'alerted' AND a.created_at > $1::timestamptz - interval '24 hours' AND a.created_at <= $1
        AND l.gone_at IS NULL
      ORDER BY a.created_at DESC, c.id
      LIMIT ${String(OPEN_DEALS_MAX)}`,
    [now],
  );
  return result.rows.map(toDeal);
}

// The figures and platform state under the overview's deals (spec 8.3).
export type OverviewStatus = {
  dealsToday: number;
  candidatesToday: number;
  ebayCallsToday: number;
  // Browse calls reserved in the quota window that holds now.
  quotaUsed: number;
  claude: { calls: number; spentMicrousd: number };
  worker: WorkerStatus | null;
  searches: SearchStatus[];
  screeningPausedUntil: Date | null;
  smtpPausedUntil: Date | null;
};

export type SearchStatus = { id: string; enabled: boolean; products: string[]; lastPoll: { status: RunStatus; startedAt: Date } | null };

// "Today" is the Berlin day; api_usage_hourly counts whole UTC hours, and Berlin midnight is one.
export async function overviewStatus(db: Queryable, now: Date): Promise<OverviewStatus> {
  const counts = await db.query<{ deals: number; candidates: number; ebay_calls: number; quota_used: number; claude_calls: number; spent: string }>(
    `SELECT
       (SELECT count(*)::int FROM app.alert a JOIN app.candidate c ON c.id = a.candidate_id
         WHERE c.decision = 'alerted' AND a.created_at >= $1 AND a.created_at <= $2) AS deals,
       (SELECT count(*)::int FROM app.candidate WHERE created_at >= $1 AND created_at <= $2) AS candidates,
       (SELECT coalesce(sum(calls), 0)::int FROM app.api_usage_hourly WHERE hour_utc >= $1 AND hour_utc <= $2) AS ebay_calls,
       (SELECT coalesce(max(used), 0)::int FROM app.ebay_quota_window
         WHERE resource = 'buy.browse' AND window_start <= $2 AND $2 < window_end) AS quota_used,
       (SELECT coalesce(max(calls), 0)::int FROM app.llm_usage_daily WHERE day_berlin = $3::date) AS claude_calls,
       (SELECT coalesce(max(spent_microusd), 0) FROM app.llm_usage_daily WHERE day_berlin = $3::date) AS spent`,
    [startOfBerlinDay(now), now, berlinDay(now)],
  );
  const row = counts.rows[0];
  const searches = await db.query<{
    id: string;
    enabled: boolean;
    products: string[];
    status: RunStatus | null;
    started_at: Date | null;
    finished_at: Date | null;
  }>(
    `SELECT s.id, s.enabled,
            coalesce(array_agg(p.name ORDER BY p.name) FILTER (WHERE p.name IS NOT NULL), '{}') AS products,
            r.status, r.started_at, r.finished_at
       FROM app.search s
       LEFT JOIN app.search_product sp ON sp.search_id = s.id
       LEFT JOIN app.product p ON p.id = sp.product_id
       LEFT JOIN LATERAL (
         SELECT x.status, x.started_at, x.finished_at FROM app.poll_run x
          WHERE x.feed_id = s.id AND x.kind = 'poll' ORDER BY x.started_at DESC LIMIT 1
       ) r ON true
      WHERE s.retired_at IS NULL
      GROUP BY s.id, r.status, r.started_at, r.finished_at
      ORDER BY length(s.id), s.id`,
  );
  const pauses = await db.query<{ screening: Date | null; smtp: Date | null }>(
    `SELECT (SELECT until FROM app.screening_pause WHERE until > $1) AS screening,
            (SELECT until FROM app.smtp_pause WHERE until > $1) AS smtp`,
    [now],
  );
  return {
    dealsToday: row?.deals ?? 0,
    candidatesToday: row?.candidates ?? 0,
    ebayCallsToday: row?.ebay_calls ?? 0,
    quotaUsed: row?.quota_used ?? 0,
    claude: { calls: row?.claude_calls ?? 0, spentMicrousd: Number(row?.spent ?? 0) },
    worker: await getWorkerStatus(db),
    searches: searches.rows.map((search) => ({
      id: search.id,
      enabled: search.enabled,
      products: search.products,
      lastPoll:
        search.status === null || search.started_at === null
          ? null
          : {
              status: effectiveRunStatus({ status: search.status, startedAt: search.started_at, finishedAt: search.finished_at }, now),
              startedAt: search.started_at,
            },
    })),
    screeningPausedUntil: pauses.rows[0]?.screening ?? null,
    smtpPausedUntil: pauses.rows[0]?.smtp ?? null,
  };
}

// Spec 8.3 /deals: every alert (alerted or blocked) and every candidate held or found to be the
// wrong product.
export const DEAL_DECISIONS = ["alerted", "blocked", "held", "wrong_product"] as const;
export type DealDecision = (typeof DEAL_DECISIONS)[number];

export const DEALS_PAGE_SIZE = 50;

export type DealsFilter = { productKey: string | null; decision: DealDecision | null; page: number };

// The product filter of /deals: each key that has a deal, by key, with its product's name.
export async function dealProducts(db: Queryable): Promise<{ key: string; name: string | null }[]> {
  const result = await db.query<{ key: string; name: string | null }>(
    `SELECT k.segment AS key, p.name
       FROM (SELECT DISTINCT segment FROM app.candidate WHERE decision = ANY($1::text[])) k
       LEFT JOIN app.product p ON p.key = k.segment
      ORDER BY k.segment`,
    [DEAL_DECISIONS],
  );
  return result.rows;
}

// Newest first, one page of 50, and how many match in all.
export async function dealsPage(db: Queryable, filter: DealsFilter, now: Date): Promise<{ rows: Deal[]; total: number }> {
  const decisions = filter.decision === null ? DEAL_DECISIONS : [filter.decision];
  const [rows, count] = await Promise.all([
    db.query<DealDb>(
      `${DEAL_SELECT}
        WHERE c.decision = ANY($2::text[]) AND ($3::text IS NULL OR c.segment = $3)
        ORDER BY c.created_at DESC, c.id
        LIMIT ${String(DEALS_PAGE_SIZE)} OFFSET $4`,
      [now, decisions, filter.productKey, (filter.page - 1) * DEALS_PAGE_SIZE],
    ),
    db.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM app.candidate WHERE decision = ANY($1::text[]) AND ($2::text IS NULL OR segment = $2)",
      [decisions, filter.productKey],
    ),
  ]);
  return { rows: rows.rows.map(toDeal), total: count.rows[0]?.total ?? 0 };
}
