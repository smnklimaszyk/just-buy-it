import type { DbPool } from "@ebay-sniper/db";
import type { SecurityEvent } from "@ebay-sniper/notify";
import type { SecurityMail } from "./security-mail.js";

// Spec 7.9: the security mail goes out for events that web, the ops CLI and the bootstrap
// write, so web reads them back from the audit log instead of each writer sending mail.
// Rows are taken in id order (uuidv7, so by insert time), and only once they are lagSeconds
// old: a transaction that took its id earlier but commits later is still seen.

export type SecurityWatchDeps = { pool: DbPool; security: SecurityMail; lagSeconds: number };

type AuditRow = {
  id: string;
  at: Date;
  actor: string;
  actor_email: string | null;
  action: string;
  email: string;
  role: "admin" | "editor";
  product: string;
  added: string[] | null;
};

type Mail = { event: SecurityEvent; concerned: string[] };

function who(row: AuditRow): string {
  if (row.actor === "system:cli") return "the ops CLI on the server";
  if (row.actor === "system:bootstrap") return "ops migrate, from AUTH_BOOTSTRAP_ADMINS";
  return row.actor_email ?? row.actor;
}

// The mail of one audit row, or null when it needs none. The person a row is about gets it too.
async function mailOf(pool: DbPool, row: AuditRow): Promise<Mail | null> {
  switch (row.action) {
    case "user.added":
      return { event: { kind: "user_added", email: row.email, role: row.role }, concerned: [row.email] };
    case "user.role_changed":
      return { event: { kind: "user_role_changed", email: row.email, role: row.role }, concerned: [row.email] };
    case "user.disabled":
      return { event: { kind: "user_disabled", email: row.email }, concerned: [row.email] };
    case "bootstrap.admin_added":
      return { event: { kind: "bootstrap_admin_added", email: row.email }, concerned: [row.email] };
    default: {
      // product.recipients_changed: only people other than the editor count.
      const others = (row.added ?? []).filter((id) => row.actor !== `user:${id}`);
      if (others.length === 0) return null;
      const people = await pool.query<{ email: string }>("SELECT email::text AS email FROM auth.app_user WHERE id = ANY($1::uuid[]) ORDER BY email", [
        others,
      ]);
      const added = people.rows.map((person) => person.email);
      return { event: { kind: "recipients_changed", product: row.product, added }, concerned: added };
    }
  }
}

// Where the watch stopped, kept across restarts so no event is mailed twice. A row in
// app.setting under a key resolveSettings does not know, so it changes no setting.
const CURSOR_KEY = "web.security_watch_cursor";

async function storedCursor(pool: DbPool): Promise<{ audit: string; auth: string } | null> {
  const result = await pool.query<{ audit: string | null; auth: string | null }>(
    "SELECT value->>'audit' AS audit, value->>'auth' AS auth FROM app.setting WHERE key = $1",
    [CURSOR_KEY],
  );
  const row = result.rows[0];
  return row?.audit == null || row.auth == null ? null : { audit: row.audit, auth: row.auth };
}

async function saveCursor(pool: DbPool, audit: string, auth: string): Promise<void> {
  await pool.query(
    `INSERT INTO app.setting (key, value, updated_at) VALUES ($1, jsonb_build_object('audit', $2::text, 'auth', $3::text), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [CURSOR_KEY, audit, auth],
  );
}

// `since`: where the first scan starts when no stored position exists. The smallest uuidv7 of
// that moment is the cursor: its first 48 bits are the Unix time in milliseconds.
export function createSecurityWatch(deps: SecurityWatchDeps, since: Date): { scan(): Promise<number> } {
  const hex = since.getTime().toString(16).padStart(12, "0");
  let cursor = `${hex.slice(0, 8)}-${hex.slice(8)}-0000-0000-000000000000`;
  let authCursor = cursor;
  let loaded = false;

  // The sign-in events of spec 7.9, from auth.auth_event: a code given out by `ops auth code`,
  // and a sign-in from a browser without a device cookie.
  const scanAuthEvents = async (): Promise<number> => {
    const rows = await deps.pool.query<{ id: string; at: Date; event: string; email: string; ip: string | null; ref: string }>(
      `SELECT e.id::text AS id, e.at, e.event, u.email::text AS email, host(coalesce(a.ip, e.ip)) AS ip, e.detail->>'ref' AS ref
       FROM auth.auth_event AS e
         JOIN auth.app_user AS u ON u.id = e.user_id
         LEFT JOIN auth.login_attempt AS a ON a.id::text = e.detail->>'attempt_id'
       WHERE e.id > $1::uuid
         AND (e.event = 'login_code_cli' OR (e.event = 'login_succeeded' AND e.detail->>'new_device' = 'true'))
         AND uuid_extract_timestamp(e.id) <= now() - make_interval(secs => $2)
       ORDER BY e.id LIMIT 100`,
      [authCursor, deps.lagSeconds],
    );
    for (const row of rows.rows) {
      const input = { at: row.at, ip: row.ip, concerned: [row.email] };
      if (row.event === "login_code_cli") {
        await deps.security.send({ kind: "login_code_cli", email: row.email, ref: row.ref }, { ...input, who: "the ops CLI on the server" });
      } else {
        await deps.security.send({ kind: "new_device_sign_in", email: row.email }, { ...input, who: row.email });
      }
      authCursor = row.id;
      await saveCursor(deps.pool, cursor, authCursor);
    }
    return rows.rows.length;
  };

  return {
    // Mails what is new since the last scan; returns how many events it handled.
    async scan() {
      if (!loaded) {
        const stored = await storedCursor(deps.pool);
        if (stored !== null) ({ audit: cursor, auth: authCursor } = stored);
        loaded = true;
      }
      const signIns = await scanAuthEvents();
      const rows = await deps.pool.query<AuditRow>(
        `SELECT a.id::text AS id, a.at, a.actor, u.email::text AS actor_email, a.action,
           a.detail->>'email' AS email, coalesce(a.detail->>'after', a.detail->>'role') AS role,
           coalesce(p.name, a.detail->>'key') AS product,
           CASE WHEN jsonb_typeof(a.detail->'added') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(a.detail->'added')) END AS added
         FROM app.audit_event AS a
           LEFT JOIN auth.app_user AS u ON a.actor = 'user:' || u.id::text
           LEFT JOIN app.product AS p ON p.key = a.detail->>'key'
         WHERE a.id > $1::uuid
           AND a.action IN ('user.added', 'user.role_changed', 'user.disabled', 'bootstrap.admin_added', 'product.recipients_changed')
           AND uuid_extract_timestamp(a.id) <= now() - make_interval(secs => $2)
         ORDER BY a.id LIMIT 100`,
        [cursor, deps.lagSeconds],
      );
      for (const row of rows.rows) {
        const mail = await mailOf(deps.pool, row);
        if (mail !== null) await deps.security.send(mail.event, { at: row.at, who: who(row), ip: null, concerned: mail.concerned });
        cursor = row.id;
        await saveCursor(deps.pool, cursor, authCursor);
      }
      return signIns + rows.rows.length;
    },
  };
}
