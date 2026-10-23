import { randomInt } from "node:crypto";
import { startOfBerlinDay } from "@ebay-sniper/domain";
import { recordAuditEvent } from "./audit.js";
import type { DbPool, Queryable } from "./pool.js";

// Spec 7.3 to 7.8, ADR 0038. The sign-in data of web and the ops CLI. Codes, addresses and IPs
// arrive as HMACs and tokens as SHA-256: AUTH_KEY stays in web and ops, never here. Nothing here
// deletes a row: role web has no DELETE on the auth tables, the worker's purge removes them.
// Times come from the caller's clock (ADR 0008), never from now().

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const LOGIN_CODE_TTL_MS = 10 * MINUTE;
export const SESSION_IDLE_MS = 24 * HOUR;
export const SESSION_ABSOLUTE_MS = 7 * 24 * HOUR;
const LAST_SEEN_STEP_MS = 5 * MINUTE;
export const DEVICE_UNUSED_MS = 180 * 24 * HOUR;

type RateWindow =
  | { kind: "fixed"; ms: number }
  | { kind: "berlin_day" }
  // Hour buckets: a slot counts until its bucket is 24 h old, so up to an hour longer than 24 h.
  | { kind: "rolling"; ms: number; bucketMs: number };

// Spec 7.5. Each counter key is `<name>:<subject>`; the subject is an HMAC, a device id or "all".
export const AUTH_LIMITS = {
  code_request_ip: { limit: 5, window: { kind: "fixed", ms: 15 * MINUTE } },
  code_check_ip: { limit: 20, window: { kind: "fixed", ms: HOUR } },
  codes_address_hour: { limit: 5, window: { kind: "fixed", ms: HOUR } },
  codes_address_day: { limit: 10, window: { kind: "berlin_day" } },
  codes_device_hour: { limit: 5, window: { kind: "fixed", ms: HOUR } },
  failed_tries_address: { limit: 10, window: { kind: "rolling", ms: 24 * HOUR, bucketMs: HOUR } },
  failed_tries_device: { limit: 10, window: { kind: "rolling", ms: 24 * HOUR, bucketMs: HOUR } },
  login_mails_day: { limit: 60, window: { kind: "berlin_day" } },
  security_mails_day: { limit: 30, window: { kind: "berlin_day" } },
  lockout_mail_hour: { limit: 1, window: { kind: "fixed", ms: HOUR } },
} as const satisfies Record<string, { limit: number; window: RateWindow }>;

export type AuthLimitName = keyof typeof AUTH_LIMITS;

const rateKey = (name: AuthLimitName, subject: string): string => `${name}:${subject}`;

function windowStart(window: RateWindow, at: Date): Date {
  if (window.kind === "berlin_day") return startOfBerlinDay(at);
  const size = window.kind === "fixed" ? window.ms : window.bucketMs;
  return new Date(Math.floor(at.getTime() / size) * size);
}

// Commits when keep(result) holds, else rolls back.
async function inTransaction<T>(
  pool: DbPool,
  fn: (client: Queryable) => Promise<T>,
  keep: (result: T) => boolean = () => true,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query(keep(result) ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// The start of the window (or bucket) the slot was taken in, or null when the limit is reached.
async function takeSlot(pool: DbPool, name: AuthLimitName, subject: string, at: Date): Promise<Date | null> {
  const { limit, window } = AUTH_LIMITS[name];
  const key = rateKey(name, subject);
  const start = windowStart(window, at);
  if (window.kind !== "rolling") {
    // Only increments below the limit, so parallel callers get exactly `limit` rows back.
    const taken = await pool.query(
      `INSERT INTO auth.rate_counter AS c (key, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = c.count + 1 WHERE c.count < $3
       RETURNING c.count`,
      [key, start, limit],
    );
    return taken.rowCount === 1 ? start : null;
  }
  // A rolling window sums several rows, which one upsert cannot guard; the key's lock can.
  return inTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    if ((await rollingCount(client, key, window, at)) >= limit) return null;
    await client.query(
      `INSERT INTO auth.rate_counter AS c (key, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = c.count + 1`,
      [key, start],
    );
    return start;
  });
}

async function rollingCount(db: Queryable, key: string, window: RateWindow & { kind: "rolling" }, at: Date): Promise<number> {
  const result = await db.query<{ n: number }>(
    "SELECT coalesce(sum(count), 0)::int AS n FROM auth.rate_counter WHERE key = $1 AND window_start > $2 AND window_start <= $3",
    [key, new Date(at.getTime() - window.ms), at],
  );
  return result.rows[0]?.n ?? 0;
}

// Takes one slot of the counter; false when its limit is reached.
export async function takeRateSlot(pool: DbPool, name: AuthLimitName, subject: string, at: Date): Promise<boolean> {
  return (await takeSlot(pool, name, subject, at)) !== null;
}

// `ops auth unlock` (spec 7.8): the failed tries of an address back to zero. Returns how many
// tries it cleared. Rows are zeroed, not deleted: web and ops have no DELETE on auth tables.
export async function unlockAddress(db: Queryable, emailMac: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `UPDATE auth.rate_counter AS c SET count = 0
     FROM (SELECT key, window_start, count FROM auth.rate_counter WHERE key = $1 AND count > 0 FOR UPDATE) AS old
     WHERE c.key = old.key AND c.window_start = old.window_start
     RETURNING old.count`,
    [rateKey("failed_tries_address", emailMac)],
  );
  return result.rows.reduce((sum, row) => sum + row.count, 0);
}

// Reads the counter without taking a slot.
export async function rateLimitReached(db: Queryable, name: AuthLimitName, subject: string, at: Date): Promise<boolean> {
  const { limit, window } = AUTH_LIMITS[name];
  const key = rateKey(name, subject);
  if (window.kind === "rolling") return (await rollingCount(db, key, window, at)) >= limit;
  const result = await db.query<{ count: number }>(
    "SELECT count FROM auth.rate_counter WHERE key = $1 AND window_start = $2",
    [key, windowStart(window, at)],
  );
  return (result.rows[0]?.count ?? 0) >= limit;
}

// Spec 7.12. A new event needs a migration that widens auth_event_event_known.
export type AuthEventName =
  | "login_code_requested"
  | "login_code_capped"
  | "login_succeeded"
  | "login_failed"
  | "login_locked"
  | "login_mail_failed"
  | "session_ended"
  | "sign_out_everywhere"
  | "login_code_cli"
  | "device_revoked";

export type AuthEventInput = {
  at: Date;
  event: AuthEventName;
  emailMac?: string | null;
  userId?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown>;
};

// Also for the events web writes itself, such as login_mail_failed.
export async function recordAuthEvent(db: Queryable, event: AuthEventInput): Promise<void> {
  await db.query("INSERT INTO auth.auth_event (at, event, user_id, email_mac, ip, detail) VALUES ($1, $2, $3, $4, $5, $6)", [
    event.at,
    event.event,
    event.userId ?? null,
    event.emailMac ?? null,
    event.ip ?? null,
    event.detail ?? {},
  ]);
}

// The reference shown on the code page (spec 2.6): no letters or digits that look alike.
const REF_ALPHABET = "ACDEFHJKMNPQRTUVWXY34679";

const newRef = (): string => Array.from({ length: 4 }, () => REF_ALPHABET.charAt(randomInt(REF_ALPHABET.length))).join("");

// email is normalized by the caller. codeMac gets the new attempt's id, because the code's HMAC
// covers it (spec 7.3).
export type LoginAttemptInput = {
  at: Date;
  email: string;
  emailMac: string;
  ipMac: string;
  ip: string | null;
  userAgent: string | null;
  attemptHash: string;
  deviceTokenHash: string | null;
  codeMac: (attemptId: string) => string;
};

export type LoginAttemptStart = { ok: true; attemptId: string; ref: string } | { ok: false; reason: "ip_limit" };

// POST /login before the reply (spec 7.2): the same steps for every address, known or not. Past
// the IP limit no attempt is written and no mail goes out.
export async function startLoginAttempt(pool: DbPool, input: LoginAttemptInput): Promise<LoginAttemptStart> {
  if (!(await takeRateSlot(pool, "code_request_ip", input.ipMac, input.at))) return { ok: false, reason: "ip_limit" };
  const person = await pool.query<{ id: string }>("SELECT id FROM auth.app_user WHERE email = $1", [input.email]);
  const userId = person.rows[0]?.id ?? null;
  const deviceId = userId === null || input.deviceTokenHash === null ? null : await validDevice(pool, input.deviceTokenHash, userId, input.at);
  const idRow = await pool.query<{ id: string }>("SELECT uuidv7()::text AS id");
  const id = idRow.rows[0]?.id;
  if (id === undefined) throw new Error("uuidv7() returned no row");
  const ref = newRef();
  await inTransaction(pool, async (client) => {
    // Parallel requests for one address close each other's rows; one at a time, they cannot deadlock.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`login_attempt:${input.emailMac}`]);
    await insertAttempt(client, input, id, ref, userId, deviceId);
  });
  await recordAuthEvent(pool, { at: input.at, event: "login_code_requested", userId, emailMac: input.emailMac, ip: input.ip });
  return { ok: true, attemptId: id, ref };
}

// A device cookie counts only for the person it was given to, while unrevoked and used in the
// last 180 days (spec 7.5).
async function validDevice(db: Queryable, tokenHash: string, userId: string, at: Date): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    "SELECT id FROM auth.device WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL AND last_used_at > $3",
    [tokenHash, userId, new Date(at.getTime() - DEVICE_UNUSED_MS)],
  );
  return result.rows[0]?.id ?? null;
}

async function insertAttempt(
  db: Queryable,
  input: LoginAttemptInput,
  id: string,
  ref: string,
  userId: string | null,
  deviceId: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO auth.login_attempt
       (id, ref, attempt_hash, user_id, device_id, email_mac, code_mac, created_at, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      ref,
      input.attemptHash,
      userId,
      deviceId,
      input.emailMac,
      input.codeMac(id),
      input.at,
      new Date(input.at.getTime() + LOGIN_CODE_TTL_MS),
      input.ip,
      input.userAgent,
    ],
  );
  // At most 3 live codes per address (spec 7.3): the oldest are closed. Browsers with a device
  // cookie count on their own, and a code from `ops auth code` is never closed this way, so
  // requests from strangers cannot close those codes (spec 7.5).
  await db.query(
    `UPDATE auth.login_attempt SET closed_at = $2
     WHERE id IN (
       SELECT a.id FROM auth.login_attempt AS a
       WHERE a.email_mac = $1 AND a.device_id IS NOT DISTINCT FROM $3
         AND a.used_at IS NULL AND a.closed_at IS NULL AND a.expires_at > $2 AND a.failed_tries < 3
         AND NOT EXISTS (
           SELECT 1 FROM auth.auth_event AS e
           WHERE e.event = 'login_code_cli' AND e.at >= a.created_at AND e.detail->>'attempt_id' = a.id::text
         )
       ORDER BY a.created_at DESC, a.id DESC
       OFFSET 3
     )`,
    [input.emailMac, input.at, deviceId],
  );
}

// GET /login/code: the reference of the browser's attempt while a code can still be typed.
export async function openAttempt(db: Queryable, attemptHash: string, at: Date): Promise<{ ref: string; expiresAt: Date } | null> {
  const result = await db.query<{ ref: string; expires_at: Date }>(
    `SELECT ref, expires_at FROM auth.login_attempt
     WHERE attempt_hash = $1 AND used_at IS NULL AND closed_at IS NULL AND expires_at > $2 AND failed_tries < 3`,
    [attemptHash, at],
  );
  const row = result.rows[0];
  return row === undefined ? null : { ref: row.ref, expiresAt: row.expires_at };
}

export type LoginMailDecision =
  | { send: true; email: string; ref: string; expiresAt: Date }
  | { send: false; reason: "not_active" | "capped" }
  | { send: false; reason: "locked"; notifyAdmins: boolean };

// POST /login after the reply: whether the code goes out by mail. Only active people's requests
// count against the caps (spec 7.5).
export async function allowLoginMail(pool: DbPool, input: { attemptId: string; at: Date }): Promise<LoginMailDecision> {
  const attempt = await pool.query<{
    ref: string;
    expires_at: Date;
    email_mac: string;
    device_id: string | null;
    email: string | null;
    status: string | null;
  }>(
    `SELECT a.ref, a.expires_at, a.email_mac, a.device_id, u.email, u.status
     FROM auth.login_attempt AS a LEFT JOIN auth.app_user AS u ON u.id = a.user_id
     WHERE a.id = $1`,
    [input.attemptId],
  );
  const row = attempt.rows[0];
  if (row === undefined || row.email === null || row.status !== "active") return { send: false, reason: "not_active" };
  // After 10 failed tries in 24 h only browsers with a device cookie get a code (spec 7.5). The
  // admins hear of it at most once an hour.
  if (row.device_id === null && (await rateLimitReached(pool, "failed_tries_address", row.email_mac, input.at))) {
    const notifyAdmins = await takeRateSlot(pool, "lockout_mail_hour", "all", input.at);
    await recordAuthEvent(pool, { at: input.at, event: "login_locked", emailMac: row.email_mac });
    return { send: false, reason: "locked", notifyAdmins };
  }
  // A browser with a device cookie has its own cap instead of the address and global caps.
  const caps: [AuthLimitName, string][] =
    row.device_id === null
      ? [
          ["codes_address_hour", row.email_mac],
          ["codes_address_day", row.email_mac],
          ["login_mails_day", "all"],
        ]
      : [["codes_device_hour", row.device_id]];
  for (const [limit, subject] of caps) {
    if (!(await takeRateSlot(pool, limit, subject, input.at))) {
      await recordAuthEvent(pool, { at: input.at, event: "login_code_capped", emailMac: row.email_mac, detail: { limit } });
      return { send: false, reason: "capped" };
    }
  }
  return { send: true, email: row.email, ref: row.ref, expiresAt: row.expires_at };
}

// POST /login/code. matches compares the typed code with the attempt's code_mac (web holds the
// key); previousSessionTokenHash is the session cookie the browser sent, if any.
export type CodeCheckInput = {
  at: Date;
  attemptHash: string;
  ipMac: string;
  ip: string | null;
  userAgent: string | null;
  matches: (attempt: { id: string; codeMac: string }) => boolean;
  sessionTokenHash: string;
  csrfSecret: string;
  previousSessionTokenHash: string | null;
  newDeviceTokenHash: string;
};

export type CodeCheckResult =
  | { ok: true; sessionId: string; userId: string; newDevice: boolean }
  | { ok: false; reason: "no_attempt" | "rate_limited" | "no_try" | "wrong_code" | "not_active" };

export type LoadedSession = {
  session: { id: string; userId: string; csrfSecret: string; createdAt: Date; expiresAt: Date };
  person: { id: string; email: string; role: "admin" | "editor" };
};

// Every request with a session cookie (spec 7.4). The role is read from auth.app_user each time.
// A session past its idle or absolute timeout is ended here and gives null.
export async function loadSession(
  pool: DbPool,
  input: { tokenHash: string; at: Date; automatic: boolean },
): Promise<LoadedSession | null> {
  const found = await pool.query<{
    id: string;
    user_id: string;
    csrf_secret: string;
    created_at: Date;
    last_seen_at: Date;
    expires_at: Date;
    email: string;
    role: "admin" | "editor";
  }>(
    `SELECT s.id, s.user_id, s.csrf_secret, s.created_at, s.last_seen_at, s.expires_at, u.email, u.role
     FROM auth.session AS s JOIN auth.app_user AS u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.ended_at IS NULL AND u.status = 'active'`,
    [input.tokenHash],
  );
  const row = found.rows[0];
  if (row === undefined) return null;
  const timedOut =
    row.expires_at <= input.at ? "absolute" : row.last_seen_at.getTime() + SESSION_IDLE_MS <= input.at.getTime() ? "idle" : null;
  if (timedOut !== null) {
    const ended = await pool.query("UPDATE auth.session SET ended_at = $2, end_reason = $3 WHERE id = $1 AND ended_at IS NULL", [
      row.id,
      input.at,
      timedOut,
    ]);
    if (ended.rowCount === 1) {
      await recordAuthEvent(pool, { at: input.at, event: "session_ended", userId: row.user_id, detail: { reason: timedOut } });
    }
    return null;
  }
  // Automatic requests (meta refresh to ?auto=1, X-Auto-Refresh) never keep a session alive, and
  // last_seen_at is written at most every 5 minutes.
  if (!input.automatic && input.at.getTime() - row.last_seen_at.getTime() >= LAST_SEEN_STEP_MS) {
    await pool.query("UPDATE auth.session SET last_seen_at = $2 WHERE id = $1", [row.id, input.at]);
  }
  return {
    session: { id: row.id, userId: row.user_id, csrfSecret: row.csrf_secret, createdAt: row.created_at, expiresAt: row.expires_at },
    person: { id: row.user_id, email: row.email, role: row.role },
  };
}

export type SessionListing = { id: string; createdAt: Date; lastSeenAt: Date; ip: string | null; userAgent: string | null };

// The account page: sessions that still work, newest first.
export async function listSessions(db: Queryable, userId: string, at: Date): Promise<SessionListing[]> {
  const result = await db.query<{ id: string; created_at: Date; last_seen_at: Date; ip: string | null; user_agent: string | null }>(
    `SELECT id, created_at, last_seen_at, ip, user_agent FROM auth.session
     WHERE user_id = $1 AND ended_at IS NULL AND expires_at > $2 AND last_seen_at > $3
     ORDER BY created_at DESC, id DESC`,
    [userId, at, new Date(at.getTime() - SESSION_IDLE_MS)],
  );
  return result.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    ip: row.ip,
    userAgent: row.user_agent,
  }));
}

// "Sign out everywhere" on the account page: every session of the person, the current one too.
export async function signOutEverywhere(db: Queryable, input: { userId: string; at: Date; ip: string | null }): Promise<number> {
  const ended = await db.query(
    "UPDATE auth.session SET ended_at = $2, end_reason = 'sign_out_everywhere' WHERE user_id = $1 AND ended_at IS NULL",
    [input.userId, input.at],
  );
  const count = ended.rowCount ?? 0;
  await recordAuthEvent(db, { at: input.at, event: "sign_out_everywhere", userId: input.userId, ip: input.ip, detail: { ended: count } });
  return count;
}

// POST /logout. False when the cookie named no open session.
export async function endSession(db: Queryable, input: { tokenHash: string; at: Date; reason: "logout" }): Promise<boolean> {
  const ended = await db.query<{ user_id: string }>(
    "UPDATE auth.session SET ended_at = $2, end_reason = $3 WHERE token_hash = $1 AND ended_at IS NULL RETURNING user_id",
    [input.tokenHash, input.at, input.reason],
  );
  const row = ended.rows[0];
  if (row === undefined) return false;
  await recordAuthEvent(db, { at: input.at, event: "session_ended", userId: row.user_id, detail: { reason: input.reason } });
  return true;
}

export type CliAttempt = { id: string; ref: string; createdAt: Date; ip: string | null; userAgent: string | null };

// `ops auth code <email> --ref <ref>` (spec 7.8): the open attempt with that reference, made in
// the last 10 minutes, so the CLI can show its time, IP and user agent before printing a code.
export async function findAttemptForCli(db: Queryable, input: { emailMac: string; ref: string; at: Date }): Promise<CliAttempt | null> {
  const result = await db.query<{ id: string; ref: string; created_at: Date; ip: string | null; user_agent: string | null }>(
    `SELECT id, ref, created_at, ip, user_agent FROM auth.login_attempt
     WHERE email_mac = $1 AND ref = $2 AND created_at > $3
       AND used_at IS NULL AND closed_at IS NULL AND expires_at > $4 AND failed_tries < 3
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [input.emailMac, input.ref, new Date(input.at.getTime() - LOGIN_CODE_TTL_MS), input.at],
  );
  const row = result.rows[0];
  return row === undefined ? null : { id: row.id, ref: row.ref, createdAt: row.created_at, ip: row.ip, userAgent: row.user_agent };
}

// After "Is this you? [y/N]": the CLI's new code replaces the mailed one, and the login_code_cli
// event audits the reference. The tries already used stay used. False when the attempt closed
// meanwhile.
export async function setCliCode(pool: DbPool, input: { attemptId: string; codeMac: string; at: Date }): Promise<boolean> {
  const result = await pool.query(
    `WITH coded AS (
       UPDATE auth.login_attempt SET code_mac = $2
       WHERE id = $1 AND used_at IS NULL AND closed_at IS NULL AND expires_at > $3 AND failed_tries < 3
       RETURNING id, ref, user_id, email_mac
     )
     INSERT INTO auth.auth_event (at, event, user_id, email_mac, detail)
     SELECT $3, 'login_code_cli', user_id, email_mac, jsonb_build_object('attempt_id', id, 'ref', ref, 'actor', 'system:cli')
     FROM coded`,
    [input.attemptId, input.codeMac, input.at],
  );
  return result.rowCount === 1;
}

// Spec 7.3: (a) take the rate slots, (b) take a try, (c) compare, (d) mark the attempt used and create the session in one
// statement, joined to an active person. The right code also uses one of the 3 tries.
export async function checkLoginCode(pool: DbPool, input: CodeCheckInput): Promise<CodeCheckResult> {
  if (!(await takeRateSlot(pool, "code_check_ip", input.ipMac, input.at))) return { ok: false, reason: "rate_limited" };
  const found = await pool.query<CheckTarget>(
    `SELECT a.id, a.email_mac, a.device_id, a.user_id,
       EXISTS (
         SELECT 1 FROM auth.auth_event AS e
         WHERE e.event = 'login_code_cli' AND e.at >= a.created_at AND e.detail->>'attempt_id' = a.id::text
       ) AS cli_code
     FROM auth.login_attempt AS a WHERE a.attempt_hash = $1`,
    [input.attemptHash],
  );
  const target = found.rows[0];
  if (target === undefined) return { ok: false, reason: "no_attempt" };
  const result = await checkAttempt(pool, input, target);
  await recordAuthEvent(pool, {
    at: input.at,
    event: result.ok ? "login_succeeded" : "login_failed",
    userId: target.user_id,
    emailMac: target.email_mac,
    ip: input.ip,
    detail: result.ok ? { new_device: result.newDevice } : { reason: result.reason },
  });
  return result;
}

type CheckTarget = { id: string; email_mac: string; device_id: string | null; user_id: string | null; cli_code: boolean };

async function checkAttempt(pool: DbPool, input: CodeCheckInput, target: CheckTarget): Promise<CodeCheckResult> {
  // (a) The slot before the try. A browser with a device cookie has its own failed tries, so a
  // stranger's guessing cannot lock it out, and a code from `ops auth code` is not affected
  // either (spec 7.5). A right code gives its slot back.
  const failedTries: [AuthLimitName, string] | null = target.cli_code
    ? null
    : target.device_id === null
      ? ["failed_tries_address", target.email_mac]
      : ["failed_tries_device", target.device_id];
  const slot = failedTries === null ? null : await takeSlot(pool, failedTries[0], failedTries[1], input.at);
  if (failedTries !== null && slot === null) return { ok: false, reason: "rate_limited" };
  const tried = await pool.query<{ id: string; code_mac: string }>(
    `UPDATE auth.login_attempt SET failed_tries = failed_tries + 1
     WHERE id = $1 AND used_at IS NULL AND closed_at IS NULL AND expires_at > $2 AND failed_tries < 3
     RETURNING id, code_mac`,
    [target.id, input.at],
  );
  const refund = failedTries === null || slot === null ? null : { name: failedTries[0], subject: failedTries[1], windowStart: slot };
  const attempt = tried.rows[0];
  // No code was compared, so the slot goes back.
  if (attempt === undefined) {
    if (refund !== null) {
      await pool.query("UPDATE auth.rate_counter SET count = count - 1 WHERE key = $1 AND window_start = $2 AND count > 0", [
        rateKey(refund.name, refund.subject),
        refund.windowStart,
      ]);
    }
    return { ok: false, reason: "no_try" };
  }
  if (!input.matches({ id: attempt.id, codeMac: attempt.code_mac })) return { ok: false, reason: "wrong_code" };
  // (d) and what comes with a new session, in one transaction: a disable that starts meanwhile
  // waits for the attempt row, then ends this session and revokes this device too.
  return inTransaction(pool, (client) => startSession(client, input, attempt.id, refund), (result) => result.ok);
}

async function startSession(
  db: Queryable,
  input: CodeCheckInput,
  attemptId: string,
  refund: { name: AuthLimitName; subject: string; windowStart: Date } | null,
): Promise<CodeCheckResult> {
  const created = await db.query<{ id: string; user_id: string }>(
    `WITH used AS (
       UPDATE auth.login_attempt AS a SET used_at = $2
       FROM auth.app_user AS u
       WHERE a.id = $1 AND a.used_at IS NULL AND a.closed_at IS NULL AND a.expires_at > $2
         AND u.id = a.user_id AND u.status = 'active'
       RETURNING a.user_id
     )
     INSERT INTO auth.session (token_hash, user_id, csrf_secret, created_at, last_seen_at, expires_at, ip, user_agent)
     SELECT $3, user_id, $4, $2, $2, $5, $6, $7 FROM used
     RETURNING id, user_id`,
    [
      attemptId,
      input.at,
      input.sessionTokenHash,
      input.csrfSecret,
      new Date(input.at.getTime() + SESSION_ABSOLUTE_MS),
      input.ip,
      input.userAgent,
    ],
  );
  const session = created.rows[0];
  if (session === undefined) return { ok: false, reason: "not_active" };
  // Only wrong codes count as failed tries.
  if (refund !== null) {
    await db.query("UPDATE auth.rate_counter SET count = count - 1 WHERE key = $1 AND window_start = $2 AND count > 0", [
      rateKey(refund.name, refund.subject),
      refund.windowStart,
    ]);
  }
  // A new token on every sign-in (spec 7.4): the session the browser came with ends.
  if (input.previousSessionTokenHash !== null) {
    await db.query(
      "UPDATE auth.session SET ended_at = $2, end_reason = 'replaced' WHERE token_hash = $1 AND ended_at IS NULL",
      [input.previousSessionTokenHash, input.at],
    );
  }
  // At most 10 sessions per person (spec 7.4): the oldest end.
  await db.query(
    `UPDATE auth.session SET ended_at = $2, end_reason = 'session_limit'
     WHERE id IN (
       SELECT id FROM auth.session WHERE user_id = $1 AND ended_at IS NULL
       ORDER BY created_at DESC, id DESC
       OFFSET 10
     )`,
    [session.user_id, input.at],
  );
  // The browser keeps its device cookie, or gets one (spec 7.5).
  const kept = await db.query(
    `UPDATE auth.device AS d SET last_used_at = $2
     FROM auth.login_attempt AS a
     WHERE a.id = $1 AND d.id = a.device_id AND d.revoked_at IS NULL`,
    [attemptId, input.at],
  );
  if (kept.rowCount === 1) return { ok: true, sessionId: session.id, userId: session.user_id, newDevice: false };
  await db.query("INSERT INTO auth.device (user_id, token_hash, created_at, last_used_at) VALUES ($1, $2, $3, $3)", [
    session.user_id,
    input.newDeviceTokenHash,
    input.at,
  ]);
  return { ok: true, sessionId: session.id, userId: session.user_id, newDevice: true };
}

// actor is "user:<uuid>" or "system:cli"; userId is the person behind a user actor.
export type AuthContext = { at: Date; actor: string; userId: string | null };

export type Role = "admin" | "editor";

export type Person = {
  id: string;
  email: string;
  role: Role;
  status: "active" | "disabled";
  createdAt: Date;
  createdBy: string | null;
  disabledAt: Date | null;
};

type PersonRow = {
  id: string;
  email: string;
  role: Role;
  status: "active" | "disabled";
  created_at: Date;
  created_by: string | null;
  disabled_at: Date | null;
};

const PERSON_COLUMNS = "id, email::text AS email, role, status, created_at, created_by, disabled_at";

const toPerson = (row: PersonRow): Person => ({
  id: row.id,
  email: row.email,
  role: row.role,
  status: row.status,
  createdAt: row.created_at,
  createdBy: row.created_by,
  disabledAt: row.disabled_at,
});

// The address is compared without regard to case (citext).
export async function findPersonByEmail(db: Queryable, email: string): Promise<Person | null> {
  const result = await db.query<PersonRow>(`SELECT ${PERSON_COLUMNS} FROM auth.app_user WHERE email = $1`, [email]);
  const row = result.rows[0];
  return row === undefined ? null : toPerson(row);
}

export async function listPeople(db: Queryable): Promise<Person[]> {
  const result = await db.query<PersonRow>(`SELECT ${PERSON_COLUMNS} FROM auth.app_user ORDER BY email`);
  return result.rows.map(toPerson);
}

// Adding is the approval (spec 7.7). The address comes normalized from the caller.
export async function addPerson(
  pool: DbPool,
  input: { email: string; role: Role },
  ctx: AuthContext,
): Promise<{ ok: true; person: Person } | { ok: false; reason: "exists" }> {
  return inTransaction(pool, async (client) => {
    const inserted = await client.query<PersonRow>(
      `INSERT INTO auth.app_user (email, role, created_at, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING ${PERSON_COLUMNS}`,
      [input.email, input.role, ctx.at, ctx.userId],
    );
    const row = inserted.rows[0];
    if (row === undefined) return { ok: false, reason: "exists" };
    await recordAuditEvent(client, { at: ctx.at, actor: ctx.actor, action: "user.added", detail: { email: row.email, role: row.role } });
    return { ok: true, person: toPerson(row) };
  });
}

export type PersonChangeResult<T> = ({ ok: true } & T) | { ok: false; reason: "not_found" | "unchanged" | "last_admin" };

// The person to change and whether they are the last active admin.
async function lockPerson(db: Queryable, userId: string): Promise<{ person: PersonRow; lastAdmin: boolean } | null> {
  const admins = await db.query<{ id: string }>(
    "SELECT id FROM auth.app_user WHERE role = 'admin' AND status = 'active' ORDER BY id FOR NO KEY UPDATE",
  );
  const found = await db.query<PersonRow>(`SELECT ${PERSON_COLUMNS} FROM auth.app_user WHERE id = $1 FOR NO KEY UPDATE`, [userId]);
  const person = found.rows[0];
  if (person === undefined) return null;
  const lastAdmin = admins.rows.length === 1 && admins.rows[0]?.id === userId;
  return { person, lastAdmin };
}

// Ends every open session of a person, with one session_ended event when any ended.
async function endSessionsOf(db: Queryable, userId: string, at: Date, reason: string): Promise<number> {
  const ended = await db.query("UPDATE auth.session SET ended_at = $2, end_reason = $3 WHERE user_id = $1 AND ended_at IS NULL", [
    userId,
    at,
    reason,
  ]);
  const count = ended.rowCount ?? 0;
  if (count > 0) await recordAuthEvent(db, { at, event: "session_ended", userId, detail: { reason, count } });
  return count;
}

type DisableResult = PersonChangeResult<{ sessionsEnded: number; devicesRevoked: number; attemptsClosed: number }>;

// Spec 7.7, in one transaction: status disabled, open login attempts closed, sessions ended,
// devices revoked. The attempts close before the sessions end: a sign-in that holds the attempt
// row commits its session first, and the session update then sees it.
export async function disablePerson(pool: DbPool, input: { userId: string }, ctx: AuthContext): Promise<DisableResult> {
  return inTransaction(
    pool,
    async (client): Promise<DisableResult> => {
      const locked = await lockPerson(client, input.userId);
      if (locked === null) return { ok: false, reason: "not_found" };
      if (locked.person.status === "disabled") return { ok: false, reason: "unchanged" };
      if (locked.lastAdmin) return { ok: false, reason: "last_admin" };
      await client.query("UPDATE auth.app_user SET status = 'disabled', disabled_at = $2 WHERE id = $1", [input.userId, ctx.at]);
      const closed = await client.query(
        "UPDATE auth.login_attempt SET closed_at = $2 WHERE user_id = $1 AND used_at IS NULL AND closed_at IS NULL",
        [input.userId, ctx.at],
      );
      const sessionsEnded = await endSessionsOf(client, input.userId, ctx.at, "disabled");
      const revoked = await client.query("UPDATE auth.device SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [
        input.userId,
        ctx.at,
      ]);
      const devicesRevoked = revoked.rowCount ?? 0;
      if (devicesRevoked > 0) {
        await recordAuthEvent(client, {
          at: ctx.at,
          event: "device_revoked",
          userId: input.userId,
          detail: { reason: "disabled", count: devicesRevoked },
        });
      }
      const attemptsClosed = closed.rowCount ?? 0;
      await recordAuditEvent(client, {
        at: ctx.at,
        actor: ctx.actor,
        action: "user.disabled",
        detail: {
          email: locked.person.email,
          sessions_ended: sessionsEnded,
          devices_revoked: devicesRevoked,
          attempts_closed: attemptsClosed,
        },
      });
      return { ok: true, sessionsEnded, devicesRevoked, attemptsClosed };
    },
    (result) => result.ok,
  );
}

// Spec 7.4 and 7.7: the person's sessions end, so the new role applies at once.
export async function changeRole(
  pool: DbPool,
  input: { userId: string; role: Role },
  ctx: AuthContext,
): Promise<PersonChangeResult<{ sessionsEnded: number }>> {
  return inTransaction(
    pool,
    async (client): Promise<PersonChangeResult<{ sessionsEnded: number }>> => {
      const locked = await lockPerson(client, input.userId);
      if (locked === null) return { ok: false, reason: "not_found" };
      if (locked.person.role === input.role) return { ok: false, reason: "unchanged" };
      if (locked.lastAdmin) return { ok: false, reason: "last_admin" };
      await client.query("UPDATE auth.app_user SET role = $2 WHERE id = $1", [input.userId, input.role]);
      const sessionsEnded = await endSessionsOf(client, input.userId, ctx.at, "role_change");
      await recordAuditEvent(client, {
        at: ctx.at,
        actor: ctx.actor,
        action: "user.role_changed",
        detail: { email: locked.person.email, before: locked.person.role, after: input.role },
      });
      return { ok: true, sessionsEnded };
    },
    (result) => result.ok,
  );
}

type EmailChangeResult = { ok: true } | { ok: false; reason: "not_found" | "exists" };

// `ops auth user set-email <old> <new>` (spec 7.8). Codes asked for under the old address close.
export async function setPersonEmail(pool: DbPool, input: { userId: string; email: string }, ctx: AuthContext): Promise<EmailChangeResult> {
  return inTransaction(
    pool,
    async (client): Promise<EmailChangeResult> => {
      const found = await client.query<{ email: string }>("SELECT email::text AS email FROM auth.app_user WHERE id = $1 FOR UPDATE", [
        input.userId,
      ]);
      const before = found.rows[0]?.email;
      if (before === undefined) return { ok: false, reason: "not_found" };
      const taken = await client.query("SELECT 1 FROM auth.app_user WHERE email = $1 AND id <> $2", [input.email, input.userId]);
      if (taken.rowCount !== 0) return { ok: false, reason: "exists" };
      await client.query("UPDATE auth.app_user SET email = $2 WHERE id = $1", [input.userId, input.email]);
      await client.query("UPDATE auth.login_attempt SET closed_at = $2 WHERE user_id = $1 AND used_at IS NULL AND closed_at IS NULL", [
        input.userId,
        ctx.at,
      ]);
      await recordAuditEvent(client, { at: ctx.at, actor: ctx.actor, action: "user.email_changed", detail: { before, after: input.email } });
      return { ok: true };
    },
    (result) => result.ok,
  );
}

// `ops auth sessions end --all`, after a lost laptop or a mailbox takeover.
export async function endAllSessions(pool: DbPool, ctx: AuthContext): Promise<number> {
  return inTransaction(pool, async (client) => {
    const ended = await client.query("UPDATE auth.session SET ended_at = $1, end_reason = 'admin' WHERE ended_at IS NULL", [ctx.at]);
    const sessionsEnded = ended.rowCount ?? 0;
    await recordAuditEvent(client, {
      at: ctx.at,
      actor: ctx.actor,
      action: "user.sessions_ended",
      detail: { all: true, sessions_ended: sessionsEnded },
    });
    return sessionsEnded;
  });
}

// An admin (step-up, spec 7.4) or `ops auth sessions end <email>` ends someone's sessions.
export async function endPersonSessions(
  pool: DbPool,
  input: { userId: string },
  ctx: AuthContext,
): Promise<PersonChangeResult<{ sessionsEnded: number }>> {
  return inTransaction(
    pool,
    async (client): Promise<PersonChangeResult<{ sessionsEnded: number }>> => {
      const found = await client.query<{ email: string }>("SELECT email::text AS email FROM auth.app_user WHERE id = $1", [input.userId]);
      const person = found.rows[0];
      if (person === undefined) return { ok: false, reason: "not_found" };
      const sessionsEnded = await endSessionsOf(client, input.userId, ctx.at, "admin");
      await recordAuditEvent(client, {
        at: ctx.at,
        actor: ctx.actor,
        action: "user.sessions_ended",
        detail: { email: person.email, sessions_ended: sessionsEnded },
      });
      return { ok: true, sessionsEnded };
    },
    (result) => result.ok,
  );
}
