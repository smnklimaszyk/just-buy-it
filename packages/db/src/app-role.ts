import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import pg from "pg";
import { addHourlyCounts, recordDeletionEvent, recordProbeSeen } from "./deletion.js";
import { PGBOSS_SCHEMA, PGBOSS_SCHEMA_VERSION } from "./queue/schema-version.js";
import { withRoleLock } from "./role-lock.js";

// The roles the server, the worker, the dashboard and web connect as (section 2.5, spec 2.10).
export type ServiceRole = "app" | "worker" | "dashboard" | "web";

type LockOptions = { lockAttempts?: number; lockRetryMs?: number };

// Gives the role LOGIN and the current password, under the cluster-wide role lock. Postgres stores
// a value that is already in SCRAM-SHA-256 form as the verifier, so the plaintext never reaches
// Postgres: not its log, not pg_stat_activity, not pg_stat_statements.
export async function setRolePassword(
  connectionString: string,
  role: ServiceRole,
  password: string,
  options: LockOptions = {},
): Promise<void> {
  const lock = { attempts: options.lockAttempts ?? 120, retryMs: options.lockRetryMs ?? 500 };
  await withRoleLock(connectionString, lock, async () => {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 });
    client.on("error", () => undefined);
    await client.connect();
    try {
      await client.query(
        `ALTER ROLE ${client.escapeIdentifier(role)} WITH LOGIN PASSWORD ${client.escapeLiteral(scramVerifier(password))}`,
      );
    } finally {
      await client.end();
    }
  });
}

export async function setAppRolePassword(
  connectionString: string,
  password: string,
  options: LockOptions = {},
): Promise<void> {
  await setRolePassword(connectionString, "app", password, options);
}

export class RoleCheckError extends Error {}

export class AppRoleCheckError extends RoleCheckError {}

// Connects as app with the URL the server will use and runs the server's own writes inside a
// transaction that is rolled back, so a wrong grant or password stops the deploy, not the server.
export async function checkAppRole(appConnectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString: appConnectionString, connectionTimeoutMillis: 10_000 });
  client.on("error", () => undefined);
  await step("connect", () => client.connect());
  try {
    // The hour comes from the database clock: packages do not read the system clock (ADR 0008).
    const hour = await step("begin", async () => {
      await client.query("BEGIN");
      const result = await client.query<{ hour: Date }>("SELECT date_trunc('hour', now(), 'UTC') AS hour");
      const [row] = result.rows;
      if (row === undefined) throw new Error("SELECT returned no row");
      return row.hour;
    });
    const event = {
      notificationId: "ops-role-check",
      topic: "MARKETPLACE_ACCOUNT_DELETION",
      eventDate: hour,
      publishAttemptCount: 1,
    };
    await step("recordDeletionEvent insert", () => recordDeletionEvent(client, event));
    await step("recordDeletionEvent update", () => recordDeletionEvent(client, event));
    await step("addHourlyCounts", () =>
      addHourlyCounts(client, {
        deletionResults: [{ hourUtc: hour, result: "dropped", count: 1 }],
        apiUsage: [{ hourUtc: hour, resource: "identity.oauth2", purpose: "token", calls: 1 }],
      }),
    );
    await step("recordProbeSeen", () => recordProbeSeen(client, hour));
    const timeout = await step("statement_timeout", async () => {
      const result = await client.query<{ statement_timeout: string }>("SHOW statement_timeout");
      return result.rows[0]?.statement_timeout;
    });
    if (timeout !== "2s") throw new AppRoleCheckError(`app role check failed at statement_timeout: ${timeout}`);
  } finally {
    // Nothing is kept. After a failed step that step's error is the one worth throwing.
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

// The message carries the step and the SQLSTATE only: a pg error message can quote values.
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new AppRoleCheckError(`app role check failed at ${name}: ${errorCode(error)}`);
  }
}

// Connects as worker with the URL the worker will use and runs one of each kind of statement the
// worker needs in a transaction that is rolled back (section 2.5). Run after the pg-boss step.
export async function checkWorkerRole(workerConnectionString: string): Promise<void> {
  const check = roleStep("worker");
  const client = new pg.Client({ connectionString: workerConnectionString, connectionTimeoutMillis: 10_000 });
  client.on("error", () => undefined);
  await check("connect", () => client.connect());
  try {
    await check("begin", () => client.query("BEGIN"));
    await check("insert poll_run", () =>
      client.query(
        "INSERT INTO app.poll_run (feed_id, kind, baseline, started_at, status) VALUES ('gpu', 'poll', false, now(), 'running')",
      ),
    );
    // min_left is the largest integer, more than any window holds, so the answer is pool and
    // nothing is spent, whatever the window's limit.
    const reserved = await check("reserve_ebay_call", async () => {
      const result = await client.query<{ result: string }>(
        "SELECT app.reserve_ebay_call('buy.browse', 'standard', 'role-check', 2147483647, now()) AS result",
      );
      return result.rows[0]?.result;
    });
    if (reserved !== "pool") throw new RoleCheckError(`worker role check failed at reserve_ebay_call: ${reserved}`);
    const version = await check("pgboss.version", async () => {
      const result = await client.query<{ version: number }>(`SELECT version FROM ${PGBOSS_SCHEMA}.version`);
      return result.rows[0]?.version;
    });
    if (version !== PGBOSS_SCHEMA_VERSION) {
      throw new RoleCheckError(`worker role check failed at pgboss.version: ${version}`);
    }
    const timeout = await check("statement_timeout", () => currentSetting(client, "statement_timeout"));
    if (timeout !== "10s") throw new RoleCheckError(`worker role check failed at statement_timeout: ${timeout}`);
  } finally {
    // Nothing is kept. After a failed step that step's error is the one worth throwing.
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

// The tables Release 0's dashboard reads (MVP section 8.2). v2 has no dashboard; the role stays for
// a rollback to Release 0 until a contract migration drops it (spec 11.3).
const RELEASE_0_DASHBOARD_TABLES = [
  "app.feed",
  "app.segment_rule",
  "app.poll_run",
  "app.candidate",
  "app.screening",
  "app.llm_usage_daily",
  "app.alert",
  "app.alert_delivery",
  "app.price_sample",
  "app.purge_run",
  "app.worker_status",
  "app.screening_pause",
  "app.smtp_pause",
  "app.api_usage_hourly",
  "ebay_live.classifier_sample",
  "ebay_live.screening_text",
];

// Connects as dashboard with the URL the migrate step sets, reads every table Release 0's
// dashboard reads and checks that a write and a read outside its grants are refused (section 2.5).
export async function checkDashboardRole(dashboardConnectionString: string): Promise<void> {
  const check = roleStep("dashboard");
  const client = new pg.Client({ connectionString: dashboardConnectionString, connectionTimeoutMillis: 10_000 });
  client.on("error", () => undefined);
  await check("connect", () => client.connect());
  try {
    const timeout = await check("statement_timeout", () => currentSetting(client, "statement_timeout"));
    if (timeout !== "2s") throw new RoleCheckError(`dashboard role check failed at statement_timeout: ${timeout}`);
    await check("begin", () => client.query("BEGIN"));
    for (const table of RELEASE_0_DASHBOARD_TABLES) {
      await check(`read ${table}`, () => client.query(`SELECT 1 FROM ${table} LIMIT 1`));
    }
    await check("rollback", () => client.query("ROLLBACK"));
    // READ WRITE, so the refusal comes from the grants and not from the read-only default.
    await check("begin read write", () => client.query("BEGIN READ WRITE"));
    await refused(
      client,
      "dashboard",
      "insert app.feed",
      "INSERT INTO app.feed (id, category_id, q, price_ceiling_cents, condition_ids, day_interval_s, night_interval_s) VALUES ('gpu', '1', 'x', 1, '{}', 60, 60) ON CONFLICT DO NOTHING",
    );
    await refused(client, "dashboard", "select app.deletion_event", "SELECT 1 FROM app.deletion_event LIMIT 1");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

// Connects as web with the URL the web service will use, reads what every page and the sign-in
// read, and checks that deleting its own sign-in trail and reading the deletion tables are refused
// (spec 2.10). Nothing is written.
export async function checkWebRole(webConnectionString: string): Promise<void> {
  const check = roleStep("web");
  const client = new pg.Client({ connectionString: webConnectionString, connectionTimeoutMillis: 10_000 });
  client.on("error", () => undefined);
  await check("connect", () => client.connect());
  try {
    const timeout = await check("statement_timeout", () => currentSetting(client, "statement_timeout"));
    if (timeout !== "2s") throw new RoleCheckError(`web role check failed at statement_timeout: ${timeout}`);
    await check("begin", () => client.query("BEGIN READ WRITE"));
    await check("select app.product", () => client.query("SELECT 1 FROM app.product LIMIT 1"));
    await check("select auth.app_user", () => client.query("SELECT 1 FROM auth.app_user LIMIT 1"));
    await refused(client, "web", "delete auth.auth_event", "DELETE FROM auth.auth_event WHERE false");
    await refused(client, "web", "select app.deletion_event", "SELECT 1 FROM app.deletion_event LIMIT 1");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

// The statement must fail with insufficient_privilege. A savepoint keeps the transaction usable.
async function refused(client: pg.Client, role: ServiceRole, name: string, statement: string): Promise<void> {
  await client.query("SAVEPOINT refused");
  let outcome = "success";
  try {
    await client.query(statement);
  } catch (error) {
    outcome = errorCode(error);
  }
  await client.query("ROLLBACK TO SAVEPOINT refused");
  if (outcome !== "42501") {
    throw new RoleCheckError(`${role} role check failed at ${name}: expected 42501, got ${outcome}`);
  }
}

// The step names the failing check; the message carries the SQLSTATE only.
function roleStep(role: ServiceRole): <T>(name: string, fn: () => Promise<T>) => Promise<T> {
  return async (name, fn) => {
    try {
      return await fn();
    } catch (error) {
      throw new RoleCheckError(`${role} role check failed at ${name}: ${errorCode(error)}`);
    }
  };
}

async function currentSetting(client: pg.Client, name: string): Promise<string | undefined> {
  const result = await client.query<{ value: string }>("SELECT current_setting($1) AS value", [name]);
  return result.rows[0]?.value;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return "unknown";
}

// RFC 5803 format, as Postgres builds it: SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>.
// The password is hex, which SASLprep leaves unchanged.
function scramVerifier(password: string): string {
  const iterations = 4096;
  const salt = randomBytes(16);
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
