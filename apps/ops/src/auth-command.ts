import { createHmac, hkdfSync, randomInt } from "node:crypto";
import { formatBerlinTime } from "@ebay-sniper/domain";
import {
  addPerson,
  disablePerson,
  endAllSessions,
  endPersonSessions,
  findAttemptForCli,
  findPersonByEmail,
  listPeople,
  LOGIN_CODE_TTL_MS,
  recordAuditEvent,
  setCliCode,
  setPersonEmail,
  unlockAddress,
  type AuthContext,
  type DbPool,
  type Person,
  type Role,
} from "@ebay-sniper/db";
import { ACTOR, failed, refused, UsageError, withPool, type OpsDeps } from "./change.js";

const USAGE =
  "usage: auth users | user add <email> admin|editor | user disable <email> | user set-email <old> <new> | sessions end <email>|--all | unlock <email> | code <email> --ref <ref>";

// Spec 7.2: trimmed, lower case, NFC, at most 254 characters and exactly one @.
function normalizedEmail(raw: string): string {
  const email = raw.trim().toLowerCase().normalize("NFC");
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new UsageError("enter one email address");
  return email;
}

// The alphabet of auth.login_attempt.ref (spec 2.6).
const REF = /^[ACDEFHJKMNPQRTUVWXY34679]{4}$/;

const authContext = (deps: OpsDeps): AuthContext => ({ at: deps.clock.now(), actor: ACTOR, userId: null });

async function add(pool: DbPool, deps: OpsDeps, email: string, role: Role): Promise<number> {
  const result = await addPerson(pool, { email, role }, authContext(deps));
  if (!result.ok) return refused(deps, { ...result, email });
  deps.out(JSON.stringify(result.person));
  return 0;
}

// The person with that address, or the not_found refusal (exit 1).
async function withPerson(pool: DbPool, deps: OpsDeps, email: string, fn: (person: Person) => Promise<number>): Promise<number> {
  const person = await findPersonByEmail(pool, email);
  return person === null ? refused(deps, { ok: false, reason: "not_found", email }) : fn(person);
}

// Spec 7.7: sessions end, devices are revoked and open codes close in the same transaction.
async function disable(pool: DbPool, deps: OpsDeps, email: string): Promise<number> {
  return withPerson(pool, deps, email, async (person) => {
    const result = await disablePerson(pool, { userId: person.id }, authContext(deps));
    if (!result.ok) return refused(deps, { ...result, email });
    deps.out(JSON.stringify({ email, ...result }));
    return 0;
  });
}

// Codes asked for under the old address close (spec 7.8).
async function setEmail(pool: DbPool, deps: OpsDeps, before: string, after: string): Promise<number> {
  return withPerson(pool, deps, before, async (person) => {
    const result = await setPersonEmail(pool, { userId: person.id, email: after }, authContext(deps));
    if (!result.ok) return refused(deps, { ...result, email: after });
    deps.out(JSON.stringify({ before, after }));
    return 0;
  });
}

// After a lost laptop or a mailbox takeover: one person's sessions, or everyone's with --all.
async function endSessions(pool: DbPool, deps: OpsDeps, who: string): Promise<number> {
  if (who === "--all") {
    deps.out(JSON.stringify({ all: true, sessionsEnded: await endAllSessions(pool, authContext(deps)) }));
    return 0;
  }
  return withPerson(pool, deps, who, async (person) => {
    const result = await endPersonSessions(pool, { userId: person.id }, authContext(deps));
    if (!result.ok) return refused(deps, { ...result, email: who });
    deps.out(JSON.stringify({ email: who, sessionsEnded: result.sessionsEnded }));
    return 0;
  });
}

// Spec 7.3: the subkeys of AUTH_KEY come from HKDF-SHA-256 with an empty salt and the label as
// info. web derives the same, so the HMACs here match the ones it stores.
const subkey = (authKey: Buffer, label: "code" | "email"): Buffer =>
  Buffer.from(hkdfSync("sha256", authKey, Buffer.alloc(0), label, 32));

const emailMac =(authKey: Buffer, email: string): string =>
  createHmac("sha256", subkey(authKey, "email")).update(email).digest("hex");

// The failed tries of an address back to zero, with the audit row in the same transaction.
async function unlock(pool: DbPool, deps: OpsDeps, email: string): Promise<number> {
  const mac = emailMac(deps.loadAuthKey(), email);
  const ctx = authContext(deps);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cleared = await unlockAddress(client, mac);
    await recordAuditEvent(client, { at: ctx.at, actor: ctx.actor, action: "user.unlocked", detail: { email, tries_cleared: cleared } });
    await client.query("COMMIT");
    deps.out(JSON.stringify({ email, triesCleared: cleared }));
    return 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const codeMac = (authKey: Buffer, attemptId: string, code: string): string =>
  createHmac("sha256", subkey(authKey, "code")).update(`${attemptId}${code}`).digest("hex");

// The user agent is text a stranger's browser sent: no control character of it reaches the
// terminal.
const printable = (text: string | null): string => (text === null ? "(none)" : text.replace(/[\p{Cc}\p{Cf}]/gu, "�"));

const minutesAgo = (from: Date, to: Date): string => {
  const minutes = Math.floor((to.getTime() - from.getTime()) / 60_000);
  return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
};

// Spec 7.8: only for a person who reads out the reference shown on their screen. The attempt's
// time, IP and user agent come first; the code only after "y".
async function code(pool: DbPool, deps: OpsDeps, email: string, ref: string): Promise<number> {
  const authKey = deps.loadAuthKey();
  const at = deps.clock.now();
  const attempt = await findAttemptForCli(pool, { emailMac: emailMac(authKey, email), ref, at });
  if (attempt === null) return refused(deps, { ok: false, reason: "not_found", email, ref });
  deps.out(`Sign-in attempt ${attempt.ref} for ${email}`);
  deps.out(`Time: ${formatBerlinTime(attempt.createdAt)} (${attempt.createdAt.toISOString()}), ${minutesAgo(attempt.createdAt, at)}`);
  deps.out(`IP: ${printable(attempt.ip)}`);
  deps.out(`User agent: ${printable(attempt.userAgent)}`);
  const answer = await deps.ask("Is this you? [y/N] ");
  if (!/^y(es)?$/i.test(answer.trim())) return refused(deps, { ok: false, reason: "not_confirmed", email, ref });
  const newCode = String(randomInt(100_000_000)).padStart(8, "0");
  const set = await setCliCode(pool, { attemptId: attempt.id, codeMac: codeMac(authKey, attempt.id, newCode), at: deps.clock.now() });
  if (!set) return refused(deps, { ok: false, reason: "attempt_closed", email, ref });
  deps.out(`Code: ${newCode}, valid until ${formatBerlinTime(new Date(attempt.createdAt.getTime() + LOGIN_CODE_TTL_MS))}`);
  return 0;
}

export async function runAuthCommand(args: readonly string[], deps: OpsDeps): Promise<number> {
  try {
    const [area, action, first, second] = args;
    if (area === "users" && args.length === 1) {
      return await withPool(deps, async (pool) => {
        for (const person of await listPeople(pool)) deps.out(JSON.stringify(person));
        return 0;
      });
    }
    if (area === "user" && action === "add" && first !== undefined && (second === "admin" || second === "editor") && args.length === 4) {
      const email = normalizedEmail(first);
      return await withPool(deps, (pool) => add(pool, deps, email, second));
    }
    if (area === "user" && action === "disable" && first !== undefined && args.length === 3) {
      const email = normalizedEmail(first);
      return await withPool(deps, (pool) => disable(pool, deps, email));
    }
    if (area === "user" && action === "set-email" && first !== undefined && second !== undefined && args.length === 4) {
      const [before, after] = [normalizedEmail(first), normalizedEmail(second)];
      return await withPool(deps, (pool) => setEmail(pool, deps, before, after));
    }
    if (area === "code" && action !== undefined && first === "--ref" && second !== undefined && args.length === 4) {
      const ref = second.toUpperCase();
      if (!REF.test(ref)) throw new UsageError("the reference is the 4 characters shown on the code page");
      const email = normalizedEmail(action);
      return await withPool(deps, (pool) => code(pool, deps, email, ref));
    }
    if (area === "unlock" && action !== undefined && args.length === 2) {
      const email = normalizedEmail(action);
      return await withPool(deps, (pool) => unlock(pool, deps, email));
    }
    if (area === "sessions" && action === "end" && first !== undefined && args.length === 3) {
      const who = first === "--all" ? first : normalizedEmail(first);
      return await withPool(deps, (pool) => endSessions(pool, deps, who));
    }
    throw new UsageError(USAGE);
  } catch (error) {
    return failed(deps, error);
  }
}
