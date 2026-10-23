import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { createPool, rateLimitReached, runMigrations, startLoginAttempt, takeRateSlot, type DbPool } from "@ebay-sniper/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpsDeps } from "./change.js";
import { runAuthCommand } from "./auth-command.js";

const AT = new Date("2026-10-22T09:00:00.000Z");
const AUTH_KEY = Buffer.alloc(32, 0x5a);

// One migrated database for this file (ADR 0023), dropped at the end.
const adminUrl = process.env.TEST_DATABASE_URL ?? "";
const name = `ops_auth_${randomBytes(6).toString("hex")}`;
const databaseUrl = Object.assign(new URL(adminUrl), { pathname: `/${name}` }).toString();
let admin: DbPool;
let pool: DbPool;

beforeAll(async () => {
  if (adminUrl === "") throw new Error("TEST_DATABASE_URL is not set: start Postgres, see README (Local Postgres for tests)");
  admin = createPool({ connectionString: adminUrl, max: 1, applicationName: "ops-test", onError: () => undefined });
  await admin.query(`CREATE DATABASE ${name}`);
  await runMigrations({ connectionString: databaseUrl, log: () => undefined });
  pool = createPool({ connectionString: databaseUrl, max: 2, applicationName: "ops-test", onError: () => undefined });
}, 120_000);

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

function run(args: string[], options: { at?: Date; answer?: string } = {}) {
  const out: string[] = [];
  const errors: Record<string, unknown>[] = [];
  const asked: string[] = [];
  const deps: OpsDeps = {
    loadEnv: () => ({ databaseUrl }),
    loadSettingsEnv: () => ({ claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null }),
    loadAuthKey: () => AUTH_KEY,
    screeningEvals: [],
    createPool,
    clock: { now: () => options.at ?? AT },
    out: (line) => out.push(line),
    // The question goes into out as well, so a test sees what was printed before it.
    ask: async (question) => {
      asked.push(question);
      out.push(`? ${question}`);
      return options.answer ?? "";
    },
    log: { info: () => undefined, error: (entry) => errors.push(entry) },
  };
  return { code: runAuthCommand(args, deps), out, errors, asked };
}

async function audit(action: string): Promise<{ actor: string; detail: Record<string, unknown> }[]> {
  const result = await pool.query<{ actor: string; detail: Record<string, unknown> }>(
    "SELECT actor, detail FROM app.audit_event WHERE action = $1 ORDER BY id",
    [action],
  );
  return result.rows;
}

describe("ops auth user", () => {
  it("adds a person with a role, normalized, as system:cli", async () => {
    const result = run(["user", "add", " Info@Intra-AI.de ", "admin"]);

    expect(await result.code).toBe(0);
    const people = await pool.query("SELECT email::text AS email, role, status, created_by FROM auth.app_user");
    expect(people.rows).toEqual([{ email: "info@intra-ai.de", role: "admin", status: "active", created_by: null }]);
    expect(await audit("user.added")).toEqual([{ actor: "system:cli", detail: { email: "info@intra-ai.de", role: "admin" } }]);
  });

  it("refuses an address that exists with exit 1, and a bad address or role with exit 2", async () => {
    const again = run(["user", "add", "info@intra-ai.de", "editor"]);
    expect(await again.code).toBe(1);
    expect(again.errors).toEqual([{ event: "ops", step: "refused", reason: "exists", email: "i…@intra-ai.de" }]);

    for (const args of [
      ["user", "add", "not-an-address", "editor"],
      ["user", "add", "a@b@intra-ai.de", "editor"],
      ["user", "add", "zoe@intra-ai.de", "owner"],
      ["user", "add", "zoe@intra-ai.de"],
    ]) {
      expect(await run(args).code, args.join(" ")).toBe(2);
    }
    expect(await audit("user.added")).toHaveLength(1);
  });

  it("lists the people with role and status, one JSON line each", async () => {
    expect(await run(["user", "add", "zoe@intra-ai.de", "editor"]).code).toBe(0);
    const result = run(["users"]);

    expect(await result.code).toBe(0);
    expect(result.out.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({ email: "info@intra-ai.de", role: "admin", status: "active" }),
      expect.objectContaining({ email: "zoe@intra-ai.de", role: "editor", status: "active" }),
    ]);
  });

  it("disables a person, and refuses the last admin and an unknown address", async () => {
    const disabled = run(["user", "disable", "Zoe@intra-ai.de"]);
    expect(await disabled.code).toBe(0);
    expect(await audit("user.disabled")).toEqual([
      { actor: "system:cli", detail: { email: "zoe@intra-ai.de", sessions_ended: 0, devices_revoked: 0, attempts_closed: 0 } },
    ]);

    const lastAdmin = run(["user", "disable", "info@intra-ai.de"]);
    expect(await lastAdmin.code).toBe(1);
    expect(lastAdmin.errors).toEqual([{ event: "ops", step: "refused", reason: "last_admin", email: "i…@intra-ai.de" }]);

    const unknown = run(["user", "disable", "nobody@intra-ai.de"]);
    expect(await unknown.code).toBe(1);
    expect(unknown.errors).toEqual([{ event: "ops", step: "refused", reason: "not_found", email: "n…@intra-ai.de" }]);
    const statuses = await pool.query("SELECT email::text AS email, status FROM auth.app_user ORDER BY email");
    expect(statuses.rows).toEqual([
      { email: "info@intra-ai.de", status: "active" },
      { email: "zoe@intra-ai.de", status: "disabled" },
    ]);
  });

  it("changes an address, and refuses one another person has", async () => {
    expect(await run(["user", "set-email", "zoe@intra-ai.de", "Zoe.Neu@intra-ai.de"]).code).toBe(0);
    expect(await audit("user.email_changed")).toEqual([
      { actor: "system:cli", detail: { before: "zoe@intra-ai.de", after: "zoe.neu@intra-ai.de" } },
    ]);

    const taken = run(["user", "set-email", "zoe.neu@intra-ai.de", "info@intra-ai.de"]);
    expect(await taken.code).toBe(1);
    expect(taken.errors).toEqual([{ event: "ops", step: "refused", reason: "exists", email: "i…@intra-ai.de" }]);
  });
});

describe("ops auth sessions end", () => {
  async function openSession(email: string): Promise<void> {
    await pool.query(
      `INSERT INTO auth.session (token_hash, user_id, csrf_secret, created_at, last_seen_at, expires_at)
       SELECT $1, id, 'csrf', $2, $2, $3 FROM auth.app_user WHERE email = $4`,
      [randomBytes(16).toString("hex"), AT, new Date(AT.getTime() + 86_400_000), email],
    );
  }

  const openSessions = async () =>
    (await pool.query("SELECT count(*)::int AS n FROM auth.session WHERE ended_at IS NULL")).rows[0] as { n: number };

  it("ends the sessions of one person, or of everyone with --all, each with an audit row", async () => {
    await openSession("info@intra-ai.de");
    await openSession("info@intra-ai.de");
    await openSession("zoe.neu@intra-ai.de");

    expect(await run(["sessions", "end", "info@intra-ai.de"]).code).toBe(0);
    expect(await openSessions()).toEqual({ n: 1 });
    expect(await run(["sessions", "end", "--all"]).code).toBe(0);
    expect(await openSessions()).toEqual({ n: 0 });
    expect(await audit("user.sessions_ended")).toEqual([
      { actor: "system:cli", detail: { email: "info@intra-ai.de", sessions_ended: 2 } },
      { actor: "system:cli", detail: { all: true, sessions_ended: 1 } },
    ]);
  });
});

// Spec 7.3, as web derives them: HKDF-SHA-256 subkeys of AUTH_KEY (empty salt, the label as info,
// 32 bytes), and HMAC-SHA-256 in hex under them.
const subkey = (label: string): Buffer => Buffer.from(hkdfSync("sha256", AUTH_KEY, Buffer.alloc(0), label, 32));
const mac = (label: string, value: string): string => createHmac("sha256", subkey(label)).update(value).digest("hex");

describe("ops auth unlock", () => {
  it("clears the failed tries of an address and writes an audit row", async () => {
    for (let i = 0; i < 10; i += 1) await takeRateSlot(pool, "failed_tries_address", mac("email", "info@intra-ai.de"), AT);
    expect(await rateLimitReached(pool, "failed_tries_address", mac("email", "info@intra-ai.de"), AT)).toBe(true);

    const result = run(["unlock", "Info@intra-ai.de"]);

    expect(await result.code).toBe(0);
    expect(await rateLimitReached(pool, "failed_tries_address", mac("email", "info@intra-ai.de"), AT)).toBe(false);
    expect(await audit("user.unlocked")).toEqual([{ actor: "system:cli", detail: { email: "info@intra-ai.de", tries_cleared: 10 } }]);
  });
});

describe("ops auth code", () => {
  it("refuses without --ref, before it reads the database or asks anything", async () => {
    for (const args of [
      ["code", "info@intra-ai.de"],
      ["code", "info@intra-ai.de", "--ref"],
      ["code", "info@intra-ai.de", "K7QF"],
      ["code", "info@intra-ai.de", "--ref", "K7Q"],
    ]) {
      const result = run(args, { answer: "y" });

      expect(await result.code, args.join(" ")).toBe(2);
      expect(result.out).toEqual([]);
      expect(result.asked).toEqual([]);
    }
  });

  const OWNER = "info@intra-ai.de";
  const MAILED_CODE = "11112222";

  async function startAttempt(at: Date, userAgent: string): Promise<{ id: string; ref: string }> {
    const started = await startLoginAttempt(pool, {
      at,
      email: OWNER,
      emailMac: mac("email", OWNER),
      ipMac: mac("ip", "203.0.113.9"),
      ip: "203.0.113.9",
      userAgent,
      attemptHash: randomBytes(32).toString("hex"),
      deviceTokenHash: null,
      codeMac: (attemptId) => mac("code", `${attemptId}${MAILED_CODE}`),
    });
    if (!started.ok) throw new Error("the test attempt was refused");
    return { id: started.attemptId, ref: started.ref };
  }

  it("prints the attempt's time, IP and user agent, asks, then prints a new code for that attempt", async () => {
    const attempt = await startAttempt(AT, "Mozilla/5.0 (Macintosh)");
    const later = new Date(AT.getTime() + 2 * 60_000);

    const result = run(["code", OWNER, "--ref", attempt.ref.toLowerCase()], { at: later, answer: "y" });

    expect(await result.code).toBe(0);
    expect(result.out.slice(0, -1)).toEqual([
      `Sign-in attempt ${attempt.ref} for ${OWNER}`,
      "Time: 11:00 CEST (2026-10-22T09:00:00.000Z), 2 minutes ago",
      "IP: 203.0.113.9",
      "User agent: Mozilla/5.0 (Macintosh)",
      "? Is this you? [y/N] ",
    ]);
    const code = /^Code: (\d{8}), valid until 11:10 CEST$/.exec(result.out.at(-1) ?? "")?.[1];
    expect(code).toBeDefined();
    const stored = await pool.query<{ code_mac: string }>("SELECT code_mac FROM auth.login_attempt WHERE id = $1", [attempt.id]);
    expect(stored.rows[0]?.code_mac).toBe(mac("code", `${attempt.id}${code ?? ""}`));
    const events = await pool.query("SELECT event, detail FROM auth.auth_event WHERE event = 'login_code_cli'");
    expect(events.rows).toEqual([
      { event: "login_code_cli", detail: { attempt_id: attempt.id, ref: attempt.ref, actor: "system:cli" } },
    ]);
  });

  it("prints no code and changes nothing unless the answer is yes", async () => {
    const attempt = await startAttempt(AT, "Mozilla/5.0 (Linux)");

    for (const answer of ["", "n", "no", "yess"]) {
      const result = run(["code", OWNER, "--ref", attempt.ref], { answer });

      expect(await result.code).toBe(1);
      expect(result.out.at(-1)).toBe("? Is this you? [y/N] ");
      expect(result.errors).toEqual([{ event: "ops", step: "refused", reason: "not_confirmed", email: "i…@intra-ai.de", ref: attempt.ref }]);
    }
    const stored = await pool.query("SELECT code_mac FROM auth.login_attempt WHERE id = $1", [attempt.id]);
    expect(stored.rows).toEqual([{ code_mac: mac("code", `${attempt.id}${MAILED_CODE}`) }]);
    const events = await pool.query("SELECT 1 FROM auth.auth_event WHERE event = 'login_code_cli' AND detail->>'attempt_id' = $1", [attempt.id]);
    expect(events.rows).toEqual([]);
  });

  it("asks nothing for a reference that is not an open attempt of that address in the last 10 minutes", async () => {
    const attempt = await startAttempt(AT, "Mozilla/5.0 (Windows)");
    const otherRef = attempt.ref === "AAAA" ? "CCCC" : "AAAA";

    for (const [email, ref, at] of [
      [OWNER, otherRef, AT],
      ["zoe.neu@intra-ai.de", attempt.ref, AT],
      [OWNER, attempt.ref, new Date(AT.getTime() + 10 * 60_000)],
    ] as const) {
      const result = run(["code", email, "--ref", ref], { at, answer: "y" });

      expect(await result.code).toBe(1);
      expect(result.out).toEqual([]);
      expect(result.errors).toEqual([{ event: "ops", step: "refused", reason: "not_found", email: email.replace(/^(.)[^@]*@/u, "$1…@"), ref }]);
    }
  });

  it("prints a user agent's control characters as replacement characters, so none reaches the terminal", async () => {
    const attempt = await startAttempt(AT, "Mozilla\u001b[2J\u009b31m‮evil\r\nIP: 10.0.0.1");

    const result = run(["code", OWNER, "--ref", attempt.ref], { answer: "n" });

    expect(await result.code).toBe(1);
    expect(result.out).toContain("User agent: Mozilla�[2J�31m�evil��IP: 10.0.0.1");
  });
});
