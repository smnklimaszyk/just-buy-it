import type { Queryable } from "@ebay-sniper/db";

// The reads of the Activity page. All run as role web (spec 2.10).

// app.audit_event (changes, 1 year) or auth.auth_event (sign-in, 90 days).
export type ActivitySource = "audit" | "auth";

export type ActivityRow = {
  id: string;
  source: ActivitySource;
  at: Date;
  event: string;
  // audit: user:<uuid> or system:<name>; auth: null.
  actor: string | null;
  // The person behind the actor or the event, when there is one.
  email: string | null;
  ip: string | null;
  detail: Record<string, unknown>;
};

export type ActivityFilter = { kind: ActivitySource | null; event: string | null };

// Both logs as one relation.
const ACTIVITY = `(
  SELECT a.id::text AS id, 'audit' AS source, a.at, a.action AS event, a.actor, u.email::text AS email, NULL::text AS ip, a.detail
  FROM app.audit_event a LEFT JOIN auth.app_user u ON a.actor = 'user:' || u.id::text
  UNION ALL
  SELECT e.id::text, 'auth', e.at, e.event, NULL, u.email::text, host(e.ip), e.detail
  FROM auth.auth_event e LEFT JOIN auth.app_user u ON u.id = e.user_id
) AS activity`;

// Spec 8.2: tables page at 50 rows.
export const ACTIVITY_PAGE_SIZE = 50;

const MATCHES = "($1::text IS NULL OR source = $1) AND ($2::text IS NULL OR event = $2)";

// One page of both logs as one list, newest first, and how many rows match in all.
export async function activityPage(db: Queryable, filter: ActivityFilter, page: number): Promise<{ rows: ActivityRow[]; total: number }> {
  const [rows, count] = await Promise.all([
    db.query<ActivityRow>(`SELECT * FROM ${ACTIVITY} WHERE ${MATCHES} ORDER BY at DESC, id DESC LIMIT $3 OFFSET $4`, [
      filter.kind,
      filter.event,
      ACTIVITY_PAGE_SIZE,
      (page - 1) * ACTIVITY_PAGE_SIZE,
    ]),
    db.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${ACTIVITY} WHERE ${MATCHES}`, [filter.kind, filter.event]),
  ]);
  return { rows: rows.rows, total: count.rows[0]?.total ?? 0 };
}

// The event names in either log, for the filter.
export async function activityEvents(db: Queryable): Promise<string[]> {
  const result = await db.query<{ event: string }>(`SELECT DISTINCT event FROM ${ACTIVITY} ORDER BY event`);
  return result.rows.map((row) => row.event);
}
