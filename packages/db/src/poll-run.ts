import type { FeedId, RunRow, RunStatus, Segment } from "@ebay-sniper/domain";
import type { DbPool, Queryable } from "./pool.js";

export type PollRunStart =
  | { kind: "poll"; feedId: FeedId; baseline: boolean; startedAt: Date }
  | { kind: "sweep"; feedId: FeedId; segment: Segment; startedAt: Date };

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

// The latest poll runs of a feed, newest first, for the due rule and the breaker (pass at least
// BREAKER_FAILURES + 1).
export async function recentPollRuns(db: Queryable, feedId: FeedId, limit: number): Promise<RunRow[]> {
  const result = await db.query<RunRowDb>(
    `SELECT status, started_at, finished_at FROM app.poll_run
      WHERE feed_id = $1 AND kind = 'poll'
      ORDER BY started_at DESC LIMIT $2`,
    [feedId, limit],
  );
  return result.rows.map(toRunRow);
}

// The latest sweeps of a segment, newest first.
export async function recentSweepRuns(db: Queryable, segment: Segment, limit: number): Promise<RunRow[]> {
  const result = await db.query<RunRowDb>(
    `SELECT status, started_at, finished_at FROM app.poll_run
      WHERE segment = $1 AND kind = 'sweep'
      ORDER BY started_at DESC LIMIT $2`,
    [segment, limit],
  );
  return result.rows.map(toRunRow);
}

// Pages beyond page 1 fetched by the feed's polls started at or after `since` (the Berlin day's
// start), for the overflow limit of section 3.2.
export async function overflowPagesSince(db: Queryable, feedId: FeedId, since: Date): Promise<number> {
  const result = await db.query<{ pages: number }>(
    `SELECT coalesce(sum(greatest(pages - 1, 0)), 0)::int AS pages FROM app.poll_run
      WHERE feed_id = $1 AND kind = 'poll' AND started_at >= $2`,
    [feedId, since],
  );
  return result.rows[0]?.pages ?? 0;
}
