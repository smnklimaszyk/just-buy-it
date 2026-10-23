import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  addPerson,
  allowLoginMail,
  AUTH_LIMITS,
  type AuthContext,
  changeRole,
  checkLoginCode,
  type CodeCheckResult,
  disablePerson,
  endAllSessions,
  endPersonSessions,
  endSession,
  findAttemptForCli,
  findPersonByEmail,
  listPeople,
  listSessions,
  loadSession,
  openAttempt,
  rateLimitReached,
  recordAuthEvent,
  setCliCode,
  setPersonEmail,
  signOutEverywhere,
  startLoginAttempt,
  takeRateSlot,
  unlockAddress,
} from "./auth-store.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// Spec 7.3 to 7.8. Every store call runs as role web, so the tests also show that web's grants
// (no DELETE on any auth table) are enough.

let database: TestDatabase;
let web: pg.Pool;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
  web = new pg.Pool({ connectionString: database.url, max: 20, options: "-c role=web" });
});

afterAll(async () => {
  await web.end();
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query(
    `TRUNCATE auth.auth_event, auth.rate_counter, auth.session, auth.login_attempt, auth.device, auth.app_user,
       app.audit_event`,
  );
});

const AT = new Date("2026-10-21T10:00:00.000Z"); // 12:00 in Berlin
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const later = (ms: number, from: Date = AT) => new Date(from.getTime() + ms);

// What web does with AUTH_KEY: HMACs for addresses, IPs and codes.
const KEY = randomBytes(32);
const mac = (value: string) => createHmac("sha256", KEY).update(value).digest("hex");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const codeMacFor = (code: string) => (attemptId: string) => mac(`${attemptId}${code}`);

const OWNER = "info@intra-ai.de";
const OWNER_IP = "198.51.100.7";
const STRANGER_IP = "203.0.113.9";

async function insertPerson(email: string, role: "admin" | "editor", status: "active" | "disabled" = "active"): Promise<string> {
  const result = await database.pool.query<{ id: string }>(
    `INSERT INTO auth.app_user (email, role, status, created_at, disabled_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'disabled' THEN $4::timestamptz END) RETURNING id`,
    [email, role, status, AT],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("no person inserted");
  return id;
}

type Browser = { ip: string; deviceToken: string | null; sessionToken: string | null };
const browser = (ip: string, deviceToken: string | null = null): Browser => ({ ip, deviceToken, sessionToken: null });

// POST /login: the attempt before the reply; allowLoginMail decides on the mail after it.
async function requestCode(email: string, from: Browser, at: Date, code = "48210937") {
  const attemptHash = sha(token());
  const started = await startLoginAttempt(web, {
    at,
    email,
    emailMac: mac(email),
    ipMac: mac(from.ip),
    ip: from.ip,
    userAgent: "test browser",
    attemptHash,
    deviceTokenHash: from.deviceToken === null ? null : sha(from.deviceToken),
    codeMac: codeMacFor(code),
  });
  return { started, attemptHash, code };
}

// The attempt of a request that must have been accepted.
function started_(request: Awaited<ReturnType<typeof requestCode>>): { attemptId: string; ref: string } {
  expect(request.started).toMatchObject({ ok: true });
  if (!request.started.ok) throw new Error("code request refused");
  return request.started;
}

function matcher(code: string, comparisons: { n: number } = { n: 0 }) {
  return (attempt: { id: string; codeMac: string }) => {
    comparisons.n += 1;
    return timingSafeEqual(Buffer.from(mac(`${attempt.id}${code}`), "hex"), Buffer.from(attempt.codeMac, "hex"));
  };
}

// POST /login/code. On success the browser keeps the new session and device cookies.
async function typeCode(
  attemptHash: string,
  code: string,
  from: Browser,
  at: Date,
  comparisons: { n: number } = { n: 0 },
): Promise<CodeCheckResult> {
  const sessionToken = token();
  const deviceToken = token();
  const result = await checkLoginCode(web, {
    at,
    attemptHash,
    ipMac: mac(from.ip),
    ip: from.ip,
    userAgent: "test browser",
    matches: matcher(code, comparisons),
    sessionTokenHash: sha(sessionToken),
    csrfSecret: token(),
    previousSessionTokenHash: from.sessionToken === null ? null : sha(from.sessionToken),
    newDeviceTokenHash: sha(deviceToken),
  });
  if (result.ok) {
    from.sessionToken = sessionToken;
    if (result.newDevice) from.deviceToken = deviceToken;
  }
  return result;
}

async function signIn(email: string, from: Browser, at: Date): Promise<CodeCheckResult> {
  const { attemptHash, code } = await requestCode(email, from, at);
  return typeCode(attemptHash, code, from, at);
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  const result = await database.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, values);
  return result.rows[0]?.n ?? 0;
}

describe("rate counters (spec 7.5)", () => {
  it("hands out exactly the limit of a fixed window to parallel callers, and starts again in the next window", async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, () => takeRateSlot(web, "code_check_ip", mac(STRANGER_IP), AT)),
    );

    expect(results.filter(Boolean)).toHaveLength(AUTH_LIMITS.code_check_ip.limit);
    expect(await rateLimitReached(web, "code_check_ip", mac(STRANGER_IP), later(59 * MINUTE))).toBe(true);
    expect(await takeRateSlot(web, "code_check_ip", mac(STRANGER_IP), later(HOUR))).toBe(true);
    expect(await takeRateSlot(web, "code_check_ip", mac(OWNER_IP), AT)).toBe(true);
    const role = await web.query<{ current_user: string }>("SELECT current_user");
    expect(role.rows[0]?.current_user).toBe("web");
  });

  it("counts a rolling 24 h window in hour buckets under parallel calls", async () => {
    const subject = mac(OWNER);
    const first = await Promise.all(Array.from({ length: 6 }, () => takeRateSlot(web, "failed_tries_address", subject, AT)));
    const second = await Promise.all(
      Array.from({ length: 10 }, () => takeRateSlot(web, "failed_tries_address", subject, later(5 * HOUR))),
    );

    expect(first.filter(Boolean)).toHaveLength(6);
    expect(second.filter(Boolean)).toHaveLength(4);
    expect(await rateLimitReached(web, "failed_tries_address", subject, later(23 * HOUR))).toBe(true);
    // The six of AT have left the window; the four of AT + 5 h are still in it.
    expect(await rateLimitReached(web, "failed_tries_address", subject, later(24 * HOUR))).toBe(false);
    const third = await Promise.all(
      Array.from({ length: 10 }, () => takeRateSlot(web, "failed_tries_address", subject, later(24 * HOUR))),
    );
    expect(third.filter(Boolean)).toHaveLength(6);
  });

  it("starts the Berlin-day counters at Berlin midnight", async () => {
    const beforeMidnight = new Date("2026-10-21T21:59:00.000Z"); // 23:59 CEST
    const afterMidnight = new Date("2026-10-21T22:01:00.000Z"); // 00:01 CEST
    const results = await Promise.all(
      Array.from({ length: 70 }, () => takeRateSlot(web, "login_mails_day", "all", beforeMidnight)),
    );

    expect(results.filter(Boolean)).toHaveLength(60);
    expect(await takeRateSlot(web, "login_mails_day", "all", afterMidnight)).toBe(true);
  });

  it("unlock clears the failed tries of an address and nothing else", async () => {
    for (let i = 0; i < 10; i += 1) await takeRateSlot(web, "failed_tries_address", mac(OWNER), AT);
    await takeRateSlot(web, "codes_address_hour", mac(OWNER), AT);

    expect(await rateLimitReached(web, "failed_tries_address", mac(OWNER), AT)).toBe(true);
    expect(await unlockAddress(web, mac(OWNER))).toBe(10);

    expect(await rateLimitReached(web, "failed_tries_address", mac(OWNER), AT)).toBe(false);
    const rows = await database.pool.query<{ key: string; count: number }>("SELECT key, count FROM auth.rate_counter ORDER BY key");
    expect(rows.rows).toEqual([
      { key: `codes_address_hour:${mac(OWNER)}`, count: 1 },
      { key: `failed_tries_address:${mac(OWNER)}`, count: 0 },
    ]);
  });
});

describe("code requests (spec 7.2, 7.3)", () => {
  it("takes the same steps for unknown, disabled and active addresses, and mails only the active one", async () => {
    await insertPerson(OWNER, "admin");
    await insertPerson("gone@example.org", "editor", "disabled");
    const results = [];
    for (const email of [OWNER, "gone@example.org", "nobody@example.org"]) {
      const started = started_(await requestCode(email, browser(OWNER_IP), AT));
      expect(started.ref).toMatch(/^[ACDEFHJKMNPQRTUVWXY34679]{4}$/);
      results.push(await allowLoginMail(web, { attemptId: started.attemptId, at: AT }));
    }

    // The attempt names the person when the address belongs to one, whatever their status.
    expect(await count("auth.login_attempt WHERE user_id IS NOT NULL"), "login_attempt rows with user_id set").toBe(2);
    expect(results[0], "a code is valid for 10 minutes").toMatchObject({ expiresAt: later(10 * MINUTE) });
    expect(results).toEqual([
      { send: true, email: OWNER, ref: expect.any(String), expiresAt: later(10 * MINUTE) },
      { send: false, reason: "not_active" },
      { send: false, reason: "not_active" },
    ]);
    expect(await count("auth.login_attempt")).toBe(3);
    const events = await database.pool.query<{ event: string; email_mac: string }>(
      "SELECT event, email_mac FROM auth.auth_event ORDER BY email_mac",
    );
    expect(events.rows).toEqual(
      [OWNER, "gone@example.org", "nobody@example.org"]
        .map((email) => ({ event: "login_code_requested", email_mac: mac(email) }))
        .sort((a, b) => a.email_mac.localeCompare(b.email_mac)),
    );
  });

  it("records the IP of a request and lets web record a failed sign-in mail", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    await requestCode(OWNER, browser(OWNER_IP), AT);
    await recordAuthEvent(web, { at: later(MINUTE), event: "login_mail_failed", userId: ownerId, detail: { smtp_code: 451 } });

    const events = await database.pool.query("SELECT event, user_id, ip, detail FROM auth.auth_event ORDER BY at");
    expect(events.rows[0], "login_code_requested with user_id and ip").toEqual({
      event: "login_code_requested",
      user_id: ownerId,
      ip: OWNER_IP,
      detail: {},
    });
    expect(events.rows, "auth events").toEqual([
      { event: "login_code_requested", user_id: ownerId, ip: OWNER_IP, detail: {} },
      { event: "login_mail_failed", user_id: ownerId, ip: null, detail: { smtp_code: 451 } },
    ]);
  });

  it("refuses the 6th request from one IP in 15 minutes without writing an attempt", async () => {
    for (let i = 0; i < 5; i += 1) started_(await requestCode(`person${i}@example.org`, browser(STRANGER_IP), AT));

    expect((await requestCode(OWNER, browser(STRANGER_IP), later(14 * MINUTE))).started).toEqual({
      ok: false,
      reason: "ip_limit",
    });
    expect(await count("auth.login_attempt")).toBe(5);
    started_(await requestCode(OWNER, browser(STRANGER_IP), later(15 * MINUTE)));
  });

  it("keeps at most 3 live codes per address, closing the oldest", async () => {
    const ids = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(started_(await requestCode(OWNER, browser(`198.51.100.${i}`), later(i * MINUTE))).attemptId);
    }

    const open = await database.pool.query<{ id: string }>(
      "SELECT id FROM auth.login_attempt WHERE closed_at IS NULL ORDER BY created_at",
    );
    expect(open.rows.map((row) => row.id), "attempts with closed_at NULL").toEqual(ids.slice(1));
    expect(await count("auth.login_attempt WHERE closed_at = $1", [later(3 * MINUTE)]), "closed at the 4th request").toBe(1);
  });

  it("does not let requests without a device cookie close the code of a browser with one", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    const owner = browser(OWNER_IP);
    await signIn(OWNER, owner, later(-DAY));
    const request = await requestCode(OWNER, owner, AT);
    for (let i = 0; i < 3; i += 1) started_(await requestCode(OWNER, browser(`203.0.113.${i + 20}`), later((i + 1) * MINUTE)));

    expect(await typeCode(request.attemptHash, request.code, owner, later(5 * MINUTE)), "the owner's code after 3 strangers' requests").toEqual({
      ok: true,
      sessionId: expect.any(String),
      userId: ownerId,
      newDevice: false,
    });
  });

  it("does not let new requests close an attempt that has a code from ops auth code", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    const request = await requestCode(OWNER, browser(OWNER_IP), AT);
    const started = started_(request);
    await setCliCode(web, { attemptId: started.attemptId, codeMac: mac(`${started.attemptId}55554444`), at: later(MINUTE) });
    for (let i = 0; i < 3; i += 1) started_(await requestCode(OWNER, browser(`203.0.113.${i + 20}`), later((i + 2) * MINUTE)));

    expect(await typeCode(request.attemptHash, "55554444", browser(OWNER_IP), later(6 * MINUTE)), "sign-in with the CLI code").toEqual({
      ok: true,
      sessionId: expect.any(String),
      userId: ownerId,
      newDevice: true,
    });
  });

  it("keeps the 3 live codes when requests arrive in parallel", async () => {
    for (let round = 0; round < 5; round += 1) {
      await database.pool.query("TRUNCATE auth.login_attempt CASCADE");
      await Promise.all(Array.from({ length: 8 }, (_, i) => requestCode(OWNER, browser(`198.51.${round}.${i}`), AT)));

      expect(await count("auth.login_attempt WHERE closed_at IS NULL"), "attempts with closed_at NULL").toBe(3);
    }
  });

  it("shows the code page only for an open attempt", async () => {
    const requests = [];
    for (let i = 0; i < 4; i += 1) requests.push(await requestCode(OWNER, browser(`198.51.100.${i}`), later(i * MINUTE)));
    const [closed, , , newest] = requests;
    if (closed === undefined || newest === undefined) throw new Error("missing request");

    expect(await openAttempt(web, newest.attemptHash, later(4 * MINUTE))).toEqual({
      ref: started_(newest).ref,
      expiresAt: later(13 * MINUTE),
    });
    expect(await openAttempt(web, closed.attemptHash, later(4 * MINUTE))).toBeNull();
    expect(await openAttempt(web, newest.attemptHash, later(13 * MINUTE))).toBeNull();
    expect(await openAttempt(web, "unknown", AT)).toBeNull();
  });

  it("mails at most 5 codes an hour and 10 a Berlin day to an address without a device cookie", async () => {
    await insertPerson(OWNER, "admin");
    const decisions = [];
    const hours = [0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2];
    for (const [i, hour] of hours.entries()) {
      // A new IP for every request, so only the address caps apply.
      const at = later(hour * HOUR);
      const started = started_(await requestCode(OWNER, browser(`198.51.100.${i}`), at));
      decisions.push((await allowLoginMail(web, { attemptId: started.attemptId, at })).send);
    }

    // Hour 0: 5 of 6 (the hour cap); hours 1 and 2: 5 more reach the day cap of 10.
    expect(decisions, "send per request").toEqual([true, true, true, true, true, false, true, true, true, true, true, false]);
    const capped = await database.pool.query("SELECT detail FROM auth.auth_event WHERE event = 'login_code_capped' ORDER BY at");
    expect(capped.rows).toEqual([{ detail: { limit: "codes_address_hour" } }, { detail: { limit: "codes_address_day" } }]);
  });

  it("sends at most 60 sign-in mails a Berlin day to browsers without a device cookie", async () => {
    await insertPerson(OWNER, "admin");
    await database.pool.query("INSERT INTO auth.rate_counter (key, window_start, count) VALUES ('login_mails_day:all', $1, 59)", [
      new Date("2026-10-20T22:00:00.000Z"),
    ]);
    const sends = [];
    for (let i = 0; i < 2; i += 1) {
      const started = started_(await requestCode(OWNER, browser(`198.51.100.${i}`), AT));
      sends.push(await allowLoginMail(web, { attemptId: started.attemptId, at: AT }));
    }

    expect(sends.map((decision) => (decision.send ? "sent" : decision.reason)), "the 60th and 61st mail").toEqual(["sent", "capped"]);
  });
});

describe("code checks (spec 7.3)", () => {
  it("signs in once with the right code", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    const request = await requestCode(OWNER, browser(OWNER_IP), AT);
    const owner = browser(OWNER_IP);

    const result = await typeCode(request.attemptHash, request.code, owner, later(MINUTE));
    const again = await typeCode(request.attemptHash, request.code, browser(OWNER_IP), later(2 * MINUTE));

    expect(result).toEqual({ ok: true, sessionId: expect.any(String), userId: ownerId, newDevice: true });
    expect(again).toEqual({ ok: false, reason: "no_try" });
    const sessions = await database.pool.query("SELECT user_id, token_hash, created_at, last_seen_at, expires_at, ended_at FROM auth.session");
    expect(sessions.rows).toEqual([
      {
        user_id: ownerId,
        token_hash: sha(owner.sessionToken ?? ""),
        created_at: later(MINUTE),
        last_seen_at: later(MINUTE),
        expires_at: later(7 * DAY + MINUTE),
        ended_at: null,
      },
    ]);
  });

  it("allows 3 tries per code, the right one included, and refuses a code after 10 minutes", async () => {
    await insertPerson(OWNER, "admin");
    const first = await requestCode(OWNER, browser(OWNER_IP), AT);
    const second = await requestCode(OWNER, browser(OWNER_IP), AT);
    const results = [];
    for (const code of ["11111111", "22222222", "33333333", first.code]) {
      results.push(await typeCode(first.attemptHash, code, browser(OWNER_IP), AT));
    }
    results.push(await typeCode(second.attemptHash, second.code, browser(OWNER_IP), later(10 * MINUTE + 1000)));

    expect(results.map((result) => (result.ok ? "ok" : result.reason))).toEqual([
      "wrong_code",
      "wrong_code",
      "wrong_code",
      "no_try",
      "no_try",
    ]);
    expect(await count("auth.session")).toBe(0);
    expect(await typeCode(sha("unknown"), second.code, browser(OWNER_IP), AT), "a hash no attempt has").toEqual({
      ok: false,
      reason: "no_attempt",
    });
  });

  it("gives 50 parallel wrong guesses on one attempt exactly 3 comparisons", async () => {
    await insertPerson(OWNER, "admin");
    const { attemptHash } = await requestCode(OWNER, browser(OWNER_IP), AT);
    const comparisons = { n: 0 };

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => typeCode(attemptHash, String(10_000_000 + i), browser(`198.51.100.${i}`), AT, comparisons)),
    );

    expect(comparisons.n, "comparisons").toBe(3);
    expect(results.filter((result) => result.ok)).toHaveLength(0);
    expect(await count("auth.login_attempt WHERE failed_tries = 3")).toBe(1);
  });

  it("gives two parallel right guesses one session", async () => {
    await insertPerson(OWNER, "admin");
    for (let round = 0; round < 5; round += 1) {
      const { attemptHash, code } = await requestCode(OWNER, browser(`198.51.100.${round}`), AT);
      const comparisons = { n: 0 };

      const results = await Promise.all([
        typeCode(attemptHash, code, browser(OWNER_IP), AT, comparisons),
        typeCode(attemptHash, code, browser(OWNER_IP), AT, comparisons),
      ]);

      // Whether the second guess still gets a try depends on timing; either way one session.
      expect(comparisons.n).toBeGreaterThanOrEqual(1);
      expect(results.filter((result) => result.ok), "sign-ins").toHaveLength(1);
    }
    expect(await count("auth.session"), "sessions").toBe(5);
    expect(await count("auth.device"), "devices").toBe(5);
  });

  it("refuses the code of an address that is unknown or disabled", async () => {
    await insertPerson("gone@example.org", "editor", "disabled");
    for (const email of ["gone@example.org", "nobody@example.org"]) {
      const { attemptHash, code } = await requestCode(email, browser(OWNER_IP), AT);
      expect(await typeCode(attemptHash, code, browser(OWNER_IP), AT), email).toEqual({ ok: false, reason: "not_active" });
    }
    expect(await count("auth.session")).toBe(0);
  });

  it("ends the session the browser sent when it signs in again", async () => {
    await insertPerson(OWNER, "admin");
    const owner = browser(OWNER_IP);
    const first = await requestCode(OWNER, owner, AT);
    await typeCode(first.attemptHash, first.code, owner, AT);
    const oldSession = owner.sessionToken ?? "";
    const second = await requestCode(OWNER, owner, later(MINUTE));
    await typeCode(second.attemptHash, second.code, owner, later(MINUTE));

    const sessions = await database.pool.query<{ token_hash: string; ended_at: Date | null; end_reason: string | null }>(
      "SELECT token_hash, ended_at, end_reason FROM auth.session ORDER BY created_at",
    );
    expect(sessions.rows, "sessions, oldest first").toEqual([
      { token_hash: sha(oldSession), ended_at: later(MINUTE), end_reason: "replaced" },
      { token_hash: sha(owner.sessionToken ?? ""), ended_at: null, end_reason: null },
    ]);
  });

  it("keeps the device of a browser that signs in again and gives a new browser a new one", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    const owner = browser(OWNER_IP);
    const first = await requestCode(OWNER, owner, AT);
    expect(await typeCode(first.attemptHash, first.code, owner, AT)).toMatchObject({ ok: true, newDevice: true });
    const deviceToken = owner.deviceToken;

    const second = await requestCode(OWNER, owner, later(DAY));
    expect(await typeCode(second.attemptHash, second.code, owner, later(DAY)), "the same browser").toMatchObject({
      ok: true,
      newDevice: false,
    });
    expect(owner.deviceToken).toBe(deviceToken);
    const devices = await database.pool.query("SELECT user_id, token_hash, created_at, last_used_at FROM auth.device");
    expect(devices.rows, "device rows").toEqual([
      { user_id: ownerId, token_hash: sha(deviceToken ?? ""), created_at: AT, last_used_at: later(DAY) },
    ]);
  });

  it("treats a device cookie that is revoked or unused for 180 days as a new browser", async () => {
    await insertPerson(OWNER, "admin");
    const stale = browser(OWNER_IP);
    const revoked = browser(OWNER_IP);
    for (const from of [stale, revoked]) {
      const request = await requestCode(OWNER, from, AT);
      await typeCode(request.attemptHash, request.code, from, AT);
    }
    await database.pool.query("UPDATE auth.device SET revoked_at = $2 WHERE token_hash = $1", [sha(revoked.deviceToken ?? ""), AT]);

    const results = [];
    for (const from of [stale, revoked]) {
      const request = await requestCode(OWNER, from, later(180 * DAY));
      results.push(await typeCode(request.attemptHash, request.code, from, later(180 * DAY)));
    }

    expect(results.map((result) => result.ok && result.newDevice), "newDevice for the stale and the revoked cookie").toEqual([true, true]);
  });

  it("records each failed and each successful check for the Activity page", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    const request = await requestCode(OWNER, browser(OWNER_IP), AT);
    await typeCode(request.attemptHash, "99999999", browser(STRANGER_IP), later(MINUTE));
    await typeCode(request.attemptHash, request.code, browser(OWNER_IP), later(2 * MINUTE));

    const events = await database.pool.query(
      "SELECT event, user_id, email_mac, ip, detail FROM auth.auth_event WHERE event IN ('login_failed', 'login_succeeded') ORDER BY at",
    );
    expect(
      events.rows.map((row: { user_id: string | null; ip: string | null }) => [row.user_id, row.ip]),
      "user_id and ip columns of the check events",
    ).toEqual([
      [ownerId, STRANGER_IP],
      [ownerId, OWNER_IP],
    ]);
    expect(events.rows, "check events").toEqual([
      { event: "login_failed", user_id: ownerId, email_mac: mac(OWNER), ip: STRANGER_IP, detail: { reason: "wrong_code" } },
      { event: "login_succeeded", user_id: ownerId, email_mac: mac(OWNER), ip: OWNER_IP, detail: { new_device: true } },
    ]);
  });

  it("keeps at most 10 sessions per person, ending the oldest", async () => {
    await insertPerson(OWNER, "admin");
    for (let i = 0; i < 11; i += 1) await signIn(OWNER, browser(`198.51.100.${i}`), later(i * MINUTE));

    const ended = await database.pool.query<{ created_at: Date; end_reason: string }>(
      "SELECT created_at, end_reason FROM auth.session WHERE ended_at IS NOT NULL",
    );
    expect(ended.rows, "ended sessions").toEqual([{ created_at: AT, end_reason: "session_limit" }]);
    expect(await count("auth.session WHERE ended_at IS NULL")).toBe(10);
  });
});

describe("device cookie and lockout (spec 7.5)", () => {
  // A stranger at one IP asks for 4 codes for the owner's address and guesses 12 times.
  async function strangerLocksTheAddress(): Promise<string[]> {
    const results: string[] = [];
    for (let request = 0; request < 4; request += 1) {
      const { attemptHash } = await requestCode(OWNER, browser(STRANGER_IP), later(request * MINUTE));
      for (let guess = 0; guess < 3; guess += 1) {
        const result = await typeCode(attemptHash, String(20_000_000 + request * 3 + guess), browser(STRANGER_IP), later(5 * MINUTE));
        results.push(result.ok ? "ok" : result.reason);
      }
    }
    return results;
  }

  it("allows 20 code checks an hour from one IP", async () => {
    const results = [];
    for (let i = 0; i < 21; i += 1) {
      // Every check on its own address, so only the IP counter applies.
      const { attemptHash } = await requestCode(`person${i}@example.org`, browser(`198.51.100.${i}`), AT);
      results.push(await typeCode(attemptHash, "12345678", browser(STRANGER_IP), AT));
    }

    expect(results.slice(0, 20).map((result) => (result.ok ? "ok" : result.reason))).toEqual(Array<string>(20).fill("wrong_code"));
    expect(results[20], "21st check from one IP: refused by code_check_ip").toEqual({ ok: false, reason: "rate_limited" });
  });

  it("counts only wrong codes as failed tries: a right code gives its slot back", async () => {
    await insertPerson(OWNER, "admin");
    const wrong = await requestCode(OWNER, browser(OWNER_IP), AT);
    await typeCode(wrong.attemptHash, "99999999", browser(OWNER_IP), AT);
    await signIn(OWNER, browser(OWNER_IP), AT);

    const counter = await database.pool.query<{ count: number }>("SELECT count FROM auth.rate_counter WHERE key = $1", [
      `failed_tries_address:${mac(OWNER)}`,
    ]);
    expect(counter.rows, "failed_tries_address after one wrong and one right code").toEqual([{ count: 1 }]);
  });

  it("does not count a try on a closed attempt as a failed try", async () => {
    await insertPerson(OWNER, "admin");
    const first = await requestCode(OWNER, browser(OWNER_IP), AT);
    for (let i = 0; i < 3; i += 1) await requestCode(OWNER, browser(`198.51.100.${i + 20}`), later((i + 1) * MINUTE));

    expect(await typeCode(first.attemptHash, first.code, browser(OWNER_IP), later(5 * MINUTE)), "code of the closed attempt").toEqual({
      ok: false,
      reason: "no_try",
    });
    const counter = await database.pool.query<{ count: number }>("SELECT count FROM auth.rate_counter WHERE key = $1", [
      `failed_tries_address:${mac(OWNER)}`,
    ]);
    expect(counter.rows, "failed_tries_address after a try on a closed attempt").toEqual([{ count: 0 }]);
  });

  it("(1) after a stranger's 12 wrong tries the owner's browser with a device cookie still gets a code and signs in", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    const owner = browser(OWNER_IP);
    await signIn(OWNER, owner, later(-2 * DAY));

    const tries = await strangerLocksTheAddress();
    expect(tries.slice(0, 10)).toEqual(Array<string>(10).fill("wrong_code"));
    expect(tries.slice(10), "11th and 12th try: refused by failed_tries_address, 10 per 24 h").toEqual([
      "rate_limited",
      "rate_limited",
    ]);
    const request = await requestCode(OWNER, owner, later(6 * MINUTE));
    expect(await allowLoginMail(web, { attemptId: started_(request).attemptId, at: later(6 * MINUTE) })).toMatchObject({ send: true });
    expect(await typeCode(request.attemptHash, request.code, owner, later(7 * MINUTE))).toEqual({
      ok: true,
      sessionId: expect.any(String),
      userId: ownerId,
      newDevice: false,
    });
  });

  it("(2) the same without a device cookie gets no code and cannot sign in", async () => {
    await insertPerson(OWNER, "admin");
    await strangerLocksTheAddress();

    const request = await requestCode(OWNER, browser(OWNER_IP), later(6 * MINUTE));
    const decision = await allowLoginMail(web, { attemptId: started_(request).attemptId, at: later(6 * MINUTE) });

    expect(decision, "mail decision for a locked address").toEqual({ send: false, reason: "locked", notifyAdmins: true });
    expect(await typeCode(request.attemptHash, request.code, browser(OWNER_IP), later(7 * MINUTE))).toEqual({
      ok: false,
      reason: "rate_limited",
    });
  });

  it("tells the admins of a lockout at most once an hour and records each refused request", async () => {
    await insertPerson(OWNER, "admin");
    await strangerLocksTheAddress();
    const notices = [];
    for (const minutes of [6, 30, 66]) {
      const request = await requestCode(OWNER, browser(`198.51.100.${minutes}`), later(minutes * MINUTE));
      const decision = await allowLoginMail(web, { attemptId: started_(request).attemptId, at: later(minutes * MINUTE) });
      notices.push(decision.send === false && decision.reason === "locked" && decision.notifyAdmins);
    }

    expect(notices).toEqual([true, false, true]);
    expect(await count("auth.auth_event WHERE event = 'login_locked'"), "login_locked events").toBe(3);
  });

  it("a device cookie skips the address and global mail caps but has its own 5 codes an hour", async () => {
    await insertPerson(OWNER, "admin");
    const owner = browser(OWNER_IP);
    await signIn(OWNER, owner, later(-DAY));
    await database.pool.query(
      `INSERT INTO auth.rate_counter (key, window_start, count) VALUES ($1, $2, 5), ($3, $4, 10), ('login_mails_day:all', $4, 60)`,
      [`codes_address_hour:${mac(OWNER)}`, AT, `codes_address_day:${mac(OWNER)}`, new Date("2026-10-20T22:00:00.000Z")],
    );
    const sends = [];
    for (let i = 0; i < 6; i += 1) {
      const request = await requestCode(OWNER, { ...owner, ip: `198.51.100.${i}` }, AT);
      sends.push((await allowLoginMail(web, { attemptId: started_(request).attemptId, at: AT })).send);
    }

    expect(sends, "send per request with the device cookie").toEqual([true, true, true, true, true, false]);
  });

  it("does not let the device cookie of another person skip the lockout", async () => {
    await insertPerson(OWNER, "admin");
    await insertPerson("second@example.org", "editor");
    const shared = browser(OWNER_IP);
    await signIn("second@example.org", shared, later(-DAY));
    await strangerLocksTheAddress();

    const request = await requestCode(OWNER, shared, later(6 * MINUTE));
    expect(await allowLoginMail(web, { attemptId: started_(request).attemptId, at: later(6 * MINUTE) })).toMatchObject({
      send: false,
      reason: "locked",
    });
  });

  it("(3) ops auth code --ref still signs the owner in", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    await strangerLocksTheAddress();
    const request = await requestCode(OWNER, browser(OWNER_IP), later(6 * MINUTE));
    const started = started_(request);

    const found = await findAttemptForCli(web, { emailMac: mac(OWNER), ref: started.ref, at: later(8 * MINUTE) });
    expect(found, "the attempt the CLI shows").toEqual({
      id: started.attemptId,
      ref: started.ref,
      createdAt: later(6 * MINUTE),
      ip: OWNER_IP,
      userAgent: "test browser",
    });
    const set = await setCliCode(web, { attemptId: started.attemptId, codeMac: mac(`${started.attemptId}55554444`), at: later(8 * MINUTE) });

    expect(set, "code replaced").toBe(true);
    const audit = await database.pool.query("SELECT user_id, email_mac, detail FROM auth.auth_event WHERE event = 'login_code_cli'");
    expect(audit.rows, "login_code_cli events with the reference").toEqual([
      { user_id: ownerId, email_mac: mac(OWNER), detail: { attempt_id: started.attemptId, ref: started.ref, actor: "system:cli" } },
    ]);
    expect(await typeCode(request.attemptHash, "55554444", browser(OWNER_IP), later(9 * MINUTE)), "sign-in with the CLI code").toEqual({
      ok: true,
      sessionId: expect.any(String),
      userId: ownerId,
      newDevice: true,
    });
  });

  it("ops auth code finds an attempt only by its reference and address, within 10 minutes, while it is open", async () => {
    await insertPerson(OWNER, "admin");
    const started = started_(await requestCode(OWNER, browser(OWNER_IP), AT));
    const otherRef = started.ref === "AAAA" ? "CCCC" : "AAAA";

    expect(await findAttemptForCli(web, { emailMac: mac(OWNER), ref: otherRef, at: AT })).toBeNull();
    expect(await findAttemptForCli(web, { emailMac: mac("x@example.org"), ref: started.ref, at: AT })).toBeNull();
    expect(await findAttemptForCli(web, { emailMac: mac(OWNER), ref: started.ref, at: later(10 * MINUTE) })).toBeNull();
    expect(await setCliCode(web, { attemptId: started.attemptId, codeMac: "x", at: later(10 * MINUTE) })).toBe(false);
    expect(await count("auth.auth_event WHERE event = 'login_code_cli'")).toBe(0);
  });
});

describe("sessions (spec 7.4)", () => {
  it("ends a session idle for more than 24 h and one older than 7 days", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    const idle = browser(OWNER_IP);
    const busy = browser(OWNER_IP);
    await signIn(OWNER, idle, AT);
    await signIn(OWNER, busy, AT);
    const idleHash = sha(idle.sessionToken ?? "");
    const busyHash = sha(busy.sessionToken ?? "");
    for (let hours = 12; hours < 7 * 24; hours += 12) {
      expect(await loadSession(web, { tokenHash: busyHash, at: later(hours * HOUR), automatic: false }), `${hours} h`).not.toBeNull();
    }

    expect(await loadSession(web, { tokenHash: idleHash, at: later(DAY - 1000), automatic: false }), "idle 24 h - 1 s").toEqual({
      session: { id: expect.any(String), userId: ownerId, csrfSecret: expect.any(String), createdAt: AT, expiresAt: later(7 * DAY) },
      person: { id: ownerId, email: OWNER, role: "admin" },
    });
    expect(await loadSession(web, { tokenHash: idleHash, at: later(2 * DAY), automatic: false }), "idle 24 h + 1 s").toBeNull();
    expect(await loadSession(web, { tokenHash: busyHash, at: later(7 * DAY), automatic: false }), "7 days old").toBeNull();
    const ended = await database.pool.query("SELECT end_reason FROM auth.session ORDER BY end_reason");
    expect(ended.rows, "end reasons").toEqual([{ end_reason: "absolute" }, { end_reason: "idle" }]);
  });

  it("signs out a tab that only refreshes itself after 24 h", async () => {
    await insertPerson(OWNER, "admin");
    const tab = browser(OWNER_IP);
    await signIn(OWNER, tab, AT);
    const tokenHash = sha(tab.sessionToken ?? "");
    for (let minutes = 5; minutes < 24 * 60; minutes += 60) {
      expect(await loadSession(web, { tokenHash, at: later(minutes * MINUTE), automatic: true })).not.toBeNull();
    }

    expect(await loadSession(web, { tokenHash, at: later(DAY + 1000), automatic: true }), "automatic request after 24 h").toBeNull();
  });

  it("writes last_seen_at at most every 5 minutes", async () => {
    await insertPerson(OWNER, "admin");
    const tab = browser(OWNER_IP);
    await signIn(OWNER, tab, AT);
    const tokenHash = sha(tab.sessionToken ?? "");
    const lastSeen = async () =>
      (await database.pool.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM auth.session")).rows[0]?.last_seen_at;

    await loadSession(web, { tokenHash, at: later(4 * MINUTE), automatic: false });
    expect(await lastSeen(), "last_seen_at after a request 4 minutes in").toEqual(AT);
    await loadSession(web, { tokenHash, at: later(5 * MINUTE), automatic: false });
    expect(await lastSeen(), "last_seen_at after a request 5 minutes in").toEqual(later(5 * MINUTE));
  });

  it("logout ends the row; the old cookie then finds nothing", async () => {
    await insertPerson(OWNER, "admin");
    const tab = browser(OWNER_IP);
    await signIn(OWNER, tab, AT);
    const tokenHash = sha(tab.sessionToken ?? "");

    expect(await endSession(web, { tokenHash, at: later(MINUTE), reason: "logout" }), "first logout").toBe(true);
    expect(await endSession(web, { tokenHash, at: later(MINUTE), reason: "logout" }), "replayed logout").toBe(false);
    expect(await loadSession(web, { tokenHash, at: later(2 * MINUTE), automatic: false })).toBeNull();
    const ended = await database.pool.query("SELECT ended_at, end_reason FROM auth.session");
    expect(ended.rows).toEqual([{ ended_at: later(MINUTE), end_reason: "logout" }]);
  });

  it("records each session end with its reason", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    const left = browser(OWNER_IP);
    const forgotten = browser(OWNER_IP);
    await signIn(OWNER, left, AT);
    await signIn(OWNER, forgotten, AT);

    await endSession(web, { tokenHash: sha(left.sessionToken ?? ""), at: later(MINUTE), reason: "logout" });
    await loadSession(web, { tokenHash: sha(forgotten.sessionToken ?? ""), at: later(2 * DAY), automatic: false });

    const events = await database.pool.query("SELECT user_id, detail FROM auth.auth_event WHERE event = 'session_ended' ORDER BY at");
    expect(events.rows, "session_ended events").toEqual([
      { user_id: ownerId, detail: { reason: "logout" } },
      { user_id: ownerId, detail: { reason: "idle" } },
    ]);
  });

  it("lists a person's open sessions for the account page, newest first", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    await signIn(OWNER, browser(OWNER_IP), AT);
    await signIn(OWNER, browser(STRANGER_IP), later(MINUTE));
    const gone = browser("198.51.100.99");
    await signIn(OWNER, gone, later(2 * MINUTE));
    await endSession(web, { tokenHash: sha(gone.sessionToken ?? ""), at: later(3 * MINUTE), reason: "logout" });

    expect(await listSessions(web, ownerId, later(4 * MINUTE)), "open sessions").toEqual([
      { id: expect.any(String), createdAt: later(MINUTE), lastSeenAt: later(MINUTE), ip: STRANGER_IP, userAgent: "test browser" },
      { id: expect.any(String), createdAt: AT, lastSeenAt: AT, ip: OWNER_IP, userAgent: "test browser" },
    ]);
    expect(await listSessions(web, ownerId, later(DAY + MINUTE)), "after 24 h idle").toEqual([]);
  });

  it("signs a person out everywhere", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    await insertPerson("editor@example.org", "editor");
    await signIn(OWNER, browser(OWNER_IP), AT);
    await signIn(OWNER, browser(STRANGER_IP), AT);
    await signIn("editor@example.org", browser(OWNER_IP), AT);

    expect(await signOutEverywhere(web, { userId: ownerId, at: later(MINUTE), ip: OWNER_IP }), "sessions ended").toBe(2);
    expect(await count("auth.session WHERE ended_at IS NULL"), "open sessions left").toBe(1);
    const events = await database.pool.query("SELECT user_id, ip, detail FROM auth.auth_event WHERE event = 'sign_out_everywhere'");
    expect(events.rows, "sign_out_everywhere events").toEqual([{ user_id: ownerId, ip: OWNER_IP, detail: { ended: 2 } }]);
  });
});

const cli = (at: Date = AT): AuthContext => ({ at, actor: "system:cli", userId: null });
const asUser = (userId: string, at: Date = AT): AuthContext => ({ at, actor: `user:${userId}`, userId });

describe("people (spec 7.7)", () => {
  it("adds a person once, audited with who added them", async () => {
    const ownerId = await insertPerson(OWNER, "admin");

    const added = await addPerson(web, { email: "editor@example.org", role: "editor" }, asUser(ownerId));
    const again = await addPerson(web, { email: "EDITOR@example.org", role: "admin" }, asUser(ownerId));

    const person = {
      id: expect.any(String),
      email: "editor@example.org",
      role: "editor",
      status: "active",
      createdAt: AT,
      createdBy: ownerId,
      disabledAt: null,
    };
    expect(added, "first add").toEqual({ ok: true, person });
    expect(again, "same address again").toEqual({ ok: false, reason: "exists" });
    expect(await findPersonByEmail(web, "Editor@example.org"), "found by address").toEqual(person);
    expect((await listPeople(web)).map((row) => row.email), "people by address").toEqual(["editor@example.org", OWNER]);
    const audit = await database.pool.query("SELECT at, actor, action, detail FROM app.audit_event");
    expect(audit.rows, "audit rows").toEqual([
      { at: AT, actor: `user:${ownerId}`, action: "user.added", detail: { email: "editor@example.org", role: "editor" } },
    ]);
  });

  it("a role change ends the person's sessions, and the last active admin cannot be demoted", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    const editorId = await insertPerson("editor@example.org", "editor");
    await signIn("editor@example.org", browser(OWNER_IP), AT);

    const results = [
      await changeRole(web, { userId: editorId, role: "admin" }, asUser(ownerId)),
      await changeRole(web, { userId: editorId, role: "admin" }, asUser(ownerId, later(MINUTE))),
      await changeRole(web, { userId: ownerId, role: "editor" }, asUser(editorId, later(2 * MINUTE))),
      await changeRole(web, { userId: editorId, role: "editor" }, cli(later(3 * MINUTE))),
      await changeRole(web, { userId: "00000000-0000-0000-0000-000000000000", role: "editor" }, cli(later(4 * MINUTE))),
    ];

    expect(results, "promote, again, demote the owner, demote the last admin, unknown id").toEqual([
      { ok: true, sessionsEnded: 1 },
      { ok: false, reason: "unchanged" },
      { ok: true, sessionsEnded: 0 },
      { ok: false, reason: "last_admin" },
      { ok: false, reason: "not_found" },
    ]);
    const ended = await database.pool.query("SELECT end_reason FROM auth.session");
    expect(ended.rows).toEqual([{ end_reason: "role_change" }]);
    const audit = await database.pool.query("SELECT actor, action, detail FROM app.audit_event ORDER BY at");
    expect(audit.rows, "audit rows").toEqual([
      { actor: `user:${ownerId}`, action: "user.role_changed", detail: { email: "editor@example.org", before: "editor", after: "admin" } },
      { actor: `user:${editorId}`, action: "user.role_changed", detail: { email: OWNER, before: "admin", after: "editor" } },
    ]);
  });

  it("disable ends sessions, revokes devices and closes open attempts; a code asked for before fails after", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    const editorId = await insertPerson("editor@example.org", "editor");
    const editor = browser(OWNER_IP);
    await signIn("editor@example.org", editor, AT);
    const pending = await requestCode("editor@example.org", editor, later(MINUTE));

    const result = await disablePerson(web, { userId: editorId }, asUser(ownerId, later(2 * MINUTE)));

    expect(result, "disable").toEqual({ ok: true, sessionsEnded: 1, devicesRevoked: 1, attemptsClosed: 1 });
    expect(await disablePerson(web, { userId: editorId }, cli(later(3 * MINUTE))), "disable again").toEqual({
      ok: false,
      reason: "unchanged",
    });
    expect(await typeCode(pending.attemptHash, pending.code, editor, later(3 * MINUTE)), "the code asked for before").toEqual({
      ok: false,
      reason: "no_try",
    });
    expect(await findPersonByEmail(web, "editor@example.org")).toMatchObject({ status: "disabled", disabledAt: later(2 * MINUTE) });
    const audit = await database.pool.query("SELECT actor, action, detail FROM app.audit_event");
    expect(audit.rows, "audit rows").toEqual([
      {
        actor: `user:${ownerId}`,
        action: "user.disabled",
        detail: { email: "editor@example.org", sessions_ended: 1, devices_revoked: 1, attempts_closed: 1 },
      },
    ]);
    const events = await database.pool.query("SELECT event, detail FROM auth.auth_event WHERE event IN ('session_ended', 'device_revoked') ORDER BY event");
    expect(events.rows, "auth events").toEqual([
      { event: "device_revoked", detail: { reason: "disabled", count: 1 } },
      { event: "session_ended", detail: { reason: "disabled", count: 1 } },
    ]);
  });

  it("disable is one transaction: when its last step fails nothing of it stays", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    const editorId = await insertPerson("editor@example.org", "editor");
    const editor = browser(OWNER_IP);
    await signIn("editor@example.org", editor, AT);
    await requestCode("editor@example.org", editor, later(MINUTE));
    await database.pool.query(
      `CREATE FUNCTION auth.refuse_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'revoke refused'; END $$;
       CREATE TRIGGER refuse_revoke BEFORE UPDATE ON auth.device FOR EACH ROW EXECUTE FUNCTION auth.refuse_revoke()`,
    );
    try {
      await expect(disablePerson(web, { userId: editorId }, asUser(ownerId, later(2 * MINUTE)))).rejects.toThrow("revoke refused");
    } finally {
      await database.pool.query("DROP TRIGGER refuse_revoke ON auth.device; DROP FUNCTION auth.refuse_revoke()");
    }

    expect(await findPersonByEmail(web, "editor@example.org"), "the person").toMatchObject({ status: "active" });
    expect(await count("auth.session WHERE ended_at IS NULL"), "open sessions").toBe(1);
    expect(await count("auth.login_attempt WHERE closed_at IS NULL AND used_at IS NULL"), "open attempts").toBe(1);
    expect(await count("auth.auth_event WHERE event = 'session_ended'"), "session_ended events").toBe(0);
    expect(await count("app.audit_event"), "audit rows").toBe(0);
  });

  it("two parallel disables of the last two admins leave one admin", async () => {
    for (let round = 0; round < 10; round += 1) {
      await database.pool.query("TRUNCATE auth.app_user CASCADE");
      const first = await insertPerson(OWNER, "admin");
      const second = await insertPerson("second@example.org", "admin");

      const results = await Promise.all([
        disablePerson(web, { userId: first }, asUser(second)),
        disablePerson(web, { userId: second }, asUser(first)),
      ]);

      expect(results.map((result) => (result.ok ? "ok" : result.reason)).sort(), `round ${round}`).toEqual(["last_admin", "ok"]);
      expect(await count("auth.app_user WHERE role = 'admin' AND status = 'active'"), `admins left in round ${round}`).toBe(1);
    }
  });

  it("a parallel demote and disable of the last two admins leave one admin", async () => {
    for (let round = 0; round < 10; round += 1) {
      await database.pool.query("TRUNCATE auth.app_user CASCADE");
      const first = await insertPerson(OWNER, "admin");
      const second = await insertPerson("second@example.org", "admin");

      const results = await Promise.all([
        changeRole(web, { userId: first, role: "editor" }, cli()),
        disablePerson(web, { userId: second }, cli()),
      ]);

      expect(results.filter((result) => result.ok), `changes that went through in round ${round}`).toHaveLength(1);
      expect(await count("auth.app_user WHERE role = 'admin' AND status = 'active'"), `admins left in round ${round}`).toBe(1);
    }
  });

  it("a sign-in racing a disable never leaves an open session or device", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    for (let round = 0; round < 10; round += 1) {
      const email = `editor${round}@example.org`;
      const editorId = await insertPerson(email, "editor");
      const { attemptHash, code } = await requestCode(email, browser(`198.51.100.${round}`), AT);

      await Promise.all([typeCode(attemptHash, code, browser(OWNER_IP), AT), disablePerson(web, { userId: editorId }, asUser(ownerId))]);

      expect(await count("auth.session WHERE user_id = $1 AND ended_at IS NULL", [editorId]), `open sessions in round ${round}`).toBe(0);
      expect(await count("auth.device WHERE user_id = $1 AND revoked_at IS NULL", [editorId]), `live devices in round ${round}`).toBe(0);
    }
  });

  it("a disable that lands while a sign-in writes its device still revokes that device", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    const editorId = await insertPerson("editor@example.org", "editor");
    const { attemptHash, code } = await requestCode("editor@example.org", browser(OWNER_IP), AT);
    // Holds the sign-in between its session and its device for half a second.
    await database.pool.query(
      `CREATE FUNCTION auth.slow_device() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$;
       CREATE TRIGGER slow_device BEFORE INSERT ON auth.device FOR EACH ROW EXECUTE FUNCTION auth.slow_device()`,
    );
    try {
      const signingIn = typeCode(attemptHash, code, browser(OWNER_IP), AT);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await disablePerson(web, { userId: editorId }, asUser(ownerId));
      await signingIn;
    } finally {
      await database.pool.query("DROP TRIGGER slow_device ON auth.device; DROP FUNCTION auth.slow_device()");
    }

    expect(await count("auth.session WHERE user_id = $1 AND ended_at IS NULL", [editorId]), "open sessions").toBe(0);
    expect(await count("auth.device WHERE user_id = $1 AND revoked_at IS NULL", [editorId]), "live devices of the disabled person").toBe(0);
  });

  it("an admin ends someone's sessions, audited", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    const editorId = await insertPerson("editor@example.org", "editor");
    await signIn("editor@example.org", browser(OWNER_IP), AT);
    await signIn("editor@example.org", browser(STRANGER_IP), AT);
    await signIn(OWNER, browser(OWNER_IP), AT);

    const results = [
      await endPersonSessions(web, { userId: editorId }, asUser(ownerId, later(MINUTE))),
      await endPersonSessions(web, { userId: "00000000-0000-0000-0000-000000000000" }, cli(later(2 * MINUTE))),
    ];

    expect(results, "editor, unknown id").toEqual([{ ok: true, sessionsEnded: 2 }, { ok: false, reason: "not_found" }]);
    expect(await count("auth.session WHERE ended_at IS NULL"), "open sessions left").toBe(1);
    expect(await count("auth.session WHERE end_reason = 'admin'"), "sessions ended by an admin").toBe(2);
    const audit = await database.pool.query("SELECT actor, action, detail FROM app.audit_event");
    expect(audit.rows, "audit rows").toEqual([
      { actor: `user:${ownerId}`, action: "user.sessions_ended", detail: { email: "editor@example.org", sessions_ended: 2 } },
    ]);
  });

  it("the CLI ends every session of everyone, audited once", async () => {
    await insertPerson(OWNER, "admin");
    await insertPerson("editor@example.org", "editor");
    await signIn("editor@example.org", browser(OWNER_IP), AT);
    await signIn(OWNER, browser(OWNER_IP), AT);

    expect(await endAllSessions(web, cli(later(MINUTE))), "sessions ended").toBe(2);
    expect(await count("auth.session WHERE ended_at IS NULL"), "open sessions left").toBe(0);
    const audit = await database.pool.query("SELECT actor, action, detail FROM app.audit_event");
    expect(audit.rows, "audit rows").toEqual([{ actor: "system:cli", action: "user.sessions_ended", detail: { all: true, sessions_ended: 2 } }]);
  });

  it("changes an address for ops auth user set-email, closing the open attempts of the old one", async () => {
    const ownerId = await insertPerson(OWNER, "admin");
    await insertPerson("taken@example.org", "editor");
    await requestCode(OWNER, browser(OWNER_IP), AT);

    const results = [
      await setPersonEmail(web, { userId: ownerId, email: "taken@example.org" }, cli()),
      await setPersonEmail(web, { userId: "00000000-0000-0000-0000-000000000000", email: "x@example.org" }, cli()),
      await setPersonEmail(web, { userId: ownerId, email: "simon@intra-ai.de" }, cli(later(MINUTE))),
    ];

    expect(results, "taken address, unknown id, free address").toEqual([
      { ok: false, reason: "exists" },
      { ok: false, reason: "not_found" },
      { ok: true },
    ]);
    expect(await findPersonByEmail(web, "simon@intra-ai.de"), "found by the new address").toMatchObject({ id: ownerId });
    expect(await count("auth.login_attempt WHERE closed_at IS NULL"), "open attempts").toBe(0);
    const audit = await database.pool.query("SELECT actor, action, detail FROM app.audit_event");
    expect(audit.rows, "audit rows").toEqual([
      { actor: "system:cli", action: "user.email_changed", detail: { before: OWNER, after: "simon@intra-ai.de" } },
    ]);
  });
});
