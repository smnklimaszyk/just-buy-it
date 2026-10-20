import type { Queryable } from "./pool.js";

// ADR 0013: the audit row holds no username, userId, eiasToken or body.
export type DeletionEventInput = {
  notificationId: string;
  topic: string;
  eventDate: Date;
  publishAttemptCount: number;
};

// eBay may deliver one notification many times; a repeat keeps the highest attempt count.
export async function recordDeletionEvent(db: Queryable, event: DeletionEventInput): Promise<"inserted" | "updated"> {
  const result = await db.query<{ inserted: boolean }>(
    `INSERT INTO app.deletion_event AS d (notification_id, topic, event_date, publish_attempt_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (notification_id) DO UPDATE
       SET publish_attempt_count = GREATEST(d.publish_attempt_count, EXCLUDED.publish_attempt_count),
           updated_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [event.notificationId, event.topic, event.eventDate, event.publishAttemptCount],
  );
  return result.rows[0]?.inserted === true ? "inserted" : "updated";
}

export type HourlyCounts = {
  deletionResults: { hourUtc: Date; result: string; count: number }[];
  apiUsage: { hourUtc: Date; resource: string; purpose: string; calls: number }[];
};

// One statement, so both tables get the counts or neither does. The caller sends each key once:
// ON CONFLICT DO UPDATE cannot change one row twice in a statement.
export async function addHourlyCounts(db: Queryable, counts: HourlyCounts): Promise<void> {
  if (counts.deletionResults.length === 0 && counts.apiUsage.length === 0) return;
  await db.query(
    `WITH results AS (
       INSERT INTO app.deletion_result_hourly AS r (hour_utc, result, notifications)
       SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::integer[])
       ON CONFLICT (hour_utc, result) DO UPDATE SET notifications = r.notifications + EXCLUDED.notifications
     ), usage AS (
       INSERT INTO app.api_usage_hourly AS u (hour_utc, resource, purpose, calls)
       SELECT * FROM unnest($4::timestamptz[], $5::text[], $6::text[], $7::integer[])
       ON CONFLICT (hour_utc, resource, purpose) DO UPDATE SET calls = u.calls + EXCLUDED.calls
     )
     SELECT 1`,
    [
      counts.deletionResults.map((row) => row.hourUtc),
      counts.deletionResults.map((row) => row.result),
      counts.deletionResults.map((row) => row.count),
      counts.apiUsage.map((row) => row.hourUtc),
      counts.apiUsage.map((row) => row.resource),
      counts.apiUsage.map((row) => row.purpose),
      counts.apiUsage.map((row) => row.calls),
    ],
  );
}

// One row, overwritten. A late write with an older time never moves seen_at back.
export async function recordProbeSeen(db: Queryable, seenAt: Date): Promise<void> {
  await db.query(
    `INSERT INTO app.probe_seen AS p (id, seen_at) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET seen_at = GREATEST(p.seen_at, EXCLUDED.seen_at)`,
    [seenAt],
  );
}
