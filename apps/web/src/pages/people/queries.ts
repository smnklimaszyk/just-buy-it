import type { Queryable } from "@ebay-sniper/db";

// The reads of the People page that auth-store does not cover. All run as role web (spec 2.10).

// Per person id: the newest sign-in (auth_event, kept 90 days) and the device cookies that still
// work (not revoked, used in the last 180 days, spec 7.5).
export type PersonActivity = { lastSignInAt: Date | null; devices: number };

export async function peopleActivity(db: Queryable, at: Date): Promise<Map<string, PersonActivity>> {
  const result = await db.query<{ id: string; last_sign_in_at: Date | null; devices: number }>(
    `SELECT u.id,
       (SELECT max(e.at) FROM auth.auth_event e WHERE e.user_id = u.id AND e.event = 'login_succeeded') AS last_sign_in_at,
       (SELECT count(*)::int FROM auth.device d
          WHERE d.user_id = u.id AND d.revoked_at IS NULL AND d.last_used_at > $1::timestamptz - interval '180 days') AS devices
     FROM auth.app_user u`,
    [at],
  );
  return new Map(result.rows.map((row) => [row.id, { lastSignInAt: row.last_sign_in_at, devices: row.devices }]));
}
