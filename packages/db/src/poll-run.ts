import type { ConditionGroup, MarketValueRef, RunRow, RunStatus } from "@ebay-sniper/domain";
import type { DbPool, Queryable } from "./pool.js";

// An app.search row with its members from app.search_product (spec 2.3). The planner writes
// both on every product save; polls and poll-tick read them at the start of each job.
export type SearchRow = {
  id: string;
  categoryId: string;
  conditionIds: string[];
  q: string;
  floorEur: number;
  ceilingEur: number;
  dayIntervalS: number;
  nightIntervalS: number;
  // At least one member is active. A search of paused members only stays planned but does not poll.
  enabled: boolean;
  retired: boolean;
  // Sorted.
  productIds: string[];
};

const SEARCH_SELECT = `SELECT s.id, s.category_id, s.condition_ids, s.q, s.floor_eur, s.ceiling_eur, s.day_interval_s,
    s.night_interval_s, s.enabled, s.retired_at IS NOT NULL AS retired,
    coalesce(array_agg(sp.product_id::text ORDER BY sp.product_id) FILTER (WHERE sp.product_id IS NOT NULL), '{}') AS product_ids
  FROM app.search s LEFT JOIN app.search_product sp ON sp.search_id = s.id`;

type SearchRowDb = {
  id: string;
  category_id: string;
  condition_ids: string[];
  q: string;
  floor_eur: number;
  ceiling_eur: number;
  day_interval_s: number;
  night_interval_s: number;
  enabled: boolean;
  retired: boolean;
  product_ids: string[];
};

const toSearchRow = (row: SearchRowDb): SearchRow => ({
  id: row.id,
  categoryId: row.category_id,
  conditionIds: row.condition_ids,
  q: row.q,
  floorEur: row.floor_eur,
  ceilingEur: row.ceiling_eur,
  dayIntervalS: row.day_interval_s,
  nightIntervalS: row.night_interval_s,
  enabled: row.enabled,
  retired: row.retired,
  productIds: row.product_ids,
});

// The searches that are not retired, by id number: what poll-tick schedules and plans.
export async function listSearches(db: Queryable): Promise<SearchRow[]> {
  const result = await db.query<SearchRowDb>(
    `${SEARCH_SELECT} WHERE s.retired_at IS NULL GROUP BY s.id ORDER BY length(s.id), s.id`,
  );
  return result.rows.map(toSearchRow);
}

// One search, retired or not, for the poll of its id; null when no row has the id.
export async function loadSearch(db: Queryable, id: string): Promise<SearchRow | null> {
  const result = await db.query<SearchRowDb>(`${SEARCH_SELECT} WHERE s.id = $1 GROUP BY s.id`, [id]);
  const row = result.rows[0];
  return row === undefined ? null : toSearchRow(row);
}

// Spec 6.4: a listing's limit comes from the newest ok value computed before its first sighting
// and at most 7 days before it, so a poll that sees listings first seen at different times needs
// every ok value of the window [oldest first sighting - 7 days, now). resolveLimit picks per
// listing, group and match version. Oldest first per product; products without one are missing.
export async function okMarketValuesBetween(
  db: Queryable,
  productIds: readonly string[],
  from: Date,
  to: Date,
): Promise<Map<string, MarketValueRef[]>> {
  const result = await db.query<{
    product_id: string;
    id: string;
    condition_group: ConditionGroup;
    match_version: number;
    computed_at: Date;
    capped: boolean;
    value_cents: number | null;
  }>(
    `SELECT product_id, id, condition_group, match_version, computed_at, capped, value_cents
       FROM app.market_value
      WHERE product_id = ANY($1) AND status = 'ok' AND computed_at >= $2 AND computed_at < $3
      ORDER BY product_id, computed_at, id`,
    [productIds, from, to],
  );
  const values = new Map<string, MarketValueRef[]>();
  for (const row of result.rows) {
    const value: MarketValueRef = {
      id: row.id,
      conditionGroup: row.condition_group,
      matchVersion: row.match_version,
      computedAt: row.computed_at,
      status: "ok",
      capped: row.capped,
      valueCents: row.value_cents,
    };
    values.set(row.product_id, [...(values.get(row.product_id) ?? []), value]);
  }
  return values;
}

// v2: a poll's feed_id is its search id; a sweep's feed_id and segment are the product key.
// Rows written before v2 hold a feed id and a segment.
export type PollRunStart =
  | { kind: "poll"; feedId: string; baseline: boolean; startedAt: Date }
  | { kind: "sweep"; feedId: string; segment: string; startedAt: Date };

// Section 2.3: inserted as running in its own autocommit statement before the first request, so a
// crash leaves the row running and the stale rule can see it. It takes the pool, never a client
// inside a transaction.
export async function startPollRun(pool: DbPool, start: PollRunStart): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO app.poll_run (feed_id, segment, kind, baseline, started_at, status)
     VALUES ($1, $2, $3, $4, $5, 'running')
     RETURNING id`,
    [
      start.feedId,
      start.kind === "sweep" ? start.segment : null,
      start.kind,
      start.kind === "poll" ? start.baseline : false,
      start.startedAt,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("poll_run insert returned no row");
  return id;
}

export type PollRunErrorKind = "timeout" | "network" | "http_5xx" | "invalid_response" | "deadline" | "db";

export type PollRunFinish = {
  status: Exclude<RunStatus, "running">;
  finishedAt: Date;
  pages: number;
  items: number;
  malformed: number;
  newItems: number;
  candidates: number;
  capReached: boolean;
  warningIds: number[];
  errorKind: PollRunErrorKind | null;
  calls: number;
};

// Written in the handler's finally block. Only a running row is finished, so a second write is a
// no-op (false).
export async function finishPollRun(db: Queryable, id: string, finish: PollRunFinish): Promise<boolean> {
  const result = await db.query(
    `UPDATE app.poll_run
        SET status = $2, finished_at = $3, pages = $4, items = $5, malformed = $6, new_items = $7,
            candidates = $8, cap_reached = $9, warning_ids = $10, error_kind = $11, calls = $12
      WHERE id = $1 AND status = 'running'`,
    [
      id,
      finish.status,
      finish.finishedAt,
      finish.pages,
      finish.items,
      finish.malformed,
      finish.newItems,
      finish.candidates,
      finish.capReached,
      finish.warningIds,
      finish.errorKind,
      finish.calls,
    ],
  );
  return result.rowCount === 1;
}

type RunRowDb = { status: RunStatus; started_at: Date; finished_at: Date | null };

const toRunRow = (row: RunRowDb): RunRow => ({
  status: row.status,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

// The latest poll runs of a search, newest first, for the due rule and the breaker (pass at least
// BREAKER_FAILURES + 1).
export async function recentPollRuns(db: Queryable, feedId: string, limit: number): Promise<RunRow[]> {
  const result = await db.query<RunRowDb>(
    `SELECT status, started_at, finished_at FROM app.poll_run
      WHERE feed_id = $1 AND kind = 'poll'
      ORDER BY started_at DESC LIMIT $2`,
    [feedId, limit],
  );
  return result.rows.map(toRunRow);
}

// The latest sweeps of a product (its key in segment), newest first.
export async function recentSweepRuns(db: Queryable, segment: string, limit: number): Promise<RunRow[]> {
  const result = await db.query<RunRowDb>(
    `SELECT status, started_at, finished_at FROM app.poll_run
      WHERE segment = $1 AND kind = 'sweep'
      ORDER BY started_at DESC LIMIT $2`,
    [segment, limit],
  );
  return result.rows.map(toRunRow);
}

// Pages beyond page 1 fetched by the search's polls started at or after `since` (the Berlin day's
// start), for the overflow limit of spec 5.2.
export async function overflowPagesSince(db: Queryable, feedId: string, since: Date): Promise<number> {
  const result = await db.query<{ pages: number }>(
    `SELECT coalesce(sum(greatest(pages - 1, 0)), 0)::int AS pages FROM app.poll_run
      WHERE feed_id = $1 AND kind = 'poll' AND started_at >= $2`,
    [feedId, since],
  );
  return result.rows[0]?.pages ?? 0;
}
