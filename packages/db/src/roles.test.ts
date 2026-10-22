import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { checkDashboardRole, checkWorkerRole, RoleCheckError, setRolePassword } from "./app-role.js";
import { migrateQueue } from "./queue/migrate-queue.js";
import { withRoleLock } from "./role-lock.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// The roles worker and dashboard are cluster-wide like app: every test database on the server
// shares them, so the tests use fixed passwords and change the roles only under the role lock.

const WORKER_PASSWORD = "1111111111111111111111111111111111111111111111111111111111111111";
const DASHBOARD_PASSWORD = "2222222222222222222222222222222222222222222222222222222222222222";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

function roleUrl(role: string, password: string): string {
  const url = new URL(database.url);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

// "<role> statement_timeout <value>" sets the role's timeout in this database, under the role
// lock; anything else runs as given.
async function alter(statement: string): Promise<void> {
  const timeout = /^(worker|dashboard) statement_timeout (\w+)$/.exec(statement);
  if (timeout === null) {
    await database.pool.query(statement);
    return;
  }
  const name = new URL(database.url).pathname.slice(1);
  await withRoleLock(inject("testDatabaseAdminUrl"), { attempts: 120, retryMs: 50 }, async () => {
    await database.pool.query(`ALTER ROLE ${timeout[1]} IN DATABASE ${name} SET statement_timeout = '${timeout[2]}'`);
  });
}

let queueInstalled = false;

async function installQueue(): Promise<void> {
  if (queueInstalled) return;
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    await migrateQueue(client);
    queueInstalled = true;
  } finally {
    await client.end();
  }
}

async function connectAs(role: string, password: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: roleUrl(role, password) });
  client.on("error", () => undefined);
  await client.connect();
  return client;
}

describe("setRolePassword", () => {
  it.each([
    ["worker", WORKER_PASSWORD],
    ["dashboard", DASHBOARD_PASSWORD],
  ] as const)("gives %s LOGIN and a SCRAM verifier, so a session with the password works", async (role, password) => {
    await setRolePassword(database.url, role, password);

    const stored = await database.pool.query<{ rolcanlogin: boolean; rolpassword: string }>(
      "SELECT rolcanlogin, rolpassword FROM pg_authid WHERE rolname = $1",
      [role],
    );
    expect(stored.rows[0]?.rolcanlogin).toBe(true);
    expect(stored.rows[0]?.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
    const client = await connectAs(role, password);
    await client.end();
  });
});

describe("role defaults (migration 0005)", () => {
  it("runs worker sessions with a 10 s and dashboard sessions with a 2 s read-only default", async () => {
    await setRolePassword(database.url, "worker", WORKER_PASSWORD);
    await setRolePassword(database.url, "dashboard", DASHBOARD_PASSWORD);
    const settings = async (role: string, password: string) => {
      const client = await connectAs(role, password);
      try {
        const result = await client.query<{ timeout: string; read_only: string }>(
          "SELECT current_setting('statement_timeout') AS timeout, current_setting('default_transaction_read_only') AS read_only",
        );
        return result.rows[0];
      } finally {
        await client.end();
      }
    };

    expect(await settings("worker", WORKER_PASSWORD)).toEqual({ timeout: "10s", read_only: "off" });
    expect(await settings("dashboard", DASHBOARD_PASSWORD)).toEqual({ timeout: "2s", read_only: "on" });
  });
});

describe("checkDashboardRole", () => {
  it("passes as dashboard: every dashboard query runs, and the INSERT and the deletion_event read are refused", async () => {
    await setRolePassword(database.url, "dashboard", DASHBOARD_PASSWORD);

    await checkDashboardRole(roleUrl("dashboard", DASHBOARD_PASSWORD));
  });

  it.each([
    ["query alerts: 42501", "REVOKE SELECT ON app.alert FROM dashboard", "GRANT SELECT ON app.alert TO dashboard"],
    [
      "insert app.feed: expected 42501, got success",
      "GRANT INSERT ON app.feed TO dashboard",
      "REVOKE INSERT ON app.feed FROM dashboard",
    ],
    [
      "select app.deletion_event: expected 42501, got success",
      "GRANT SELECT ON app.deletion_event TO dashboard",
      "REVOKE SELECT ON app.deletion_event FROM dashboard",
    ],
    ["statement_timeout: 5s", "dashboard statement_timeout 5s", "dashboard statement_timeout 2s"],
  ])("fails at %s", async (expected, breakIt, restore) => {
    await setRolePassword(database.url, "dashboard", DASHBOARD_PASSWORD);
    await alter(breakIt);
    try {
      const error = await rejection(checkDashboardRole(roleUrl("dashboard", DASHBOARD_PASSWORD)));

      expect(error).toBeInstanceOf(RoleCheckError);
      expect((error as Error).message).toBe(`dashboard role check failed at ${expected}`);
      expect(JSON.stringify(error)).not.toContain(DASHBOARD_PASSWORD);
    } finally {
      await alter(restore);
    }
  });
});

describe("checkWorkerRole", () => {
  it("passes as worker once pg-boss is installed and leaves nothing behind", async () => {
    await installQueue();
    await setRolePassword(database.url, "worker", WORKER_PASSWORD);

    await checkWorkerRole(roleUrl("worker", WORKER_PASSWORD));

    const counts = await database.pool.query<{ runs: number; windows: number; usage: number }>(
      `SELECT (SELECT count(*)::int FROM app.poll_run) AS runs,
              (SELECT count(*)::int FROM app.ebay_quota_window) AS windows,
              (SELECT count(*)::int FROM app.api_usage_hourly) AS usage`,
    );
    expect(counts.rows[0]).toEqual({ runs: 0, windows: 0, usage: 0 });
  });

  it("passes when the current quota window holds more than 5,000 units", async () => {
    await installQueue();
    await setRolePassword(database.url, "worker", WORKER_PASSWORD);
    await database.pool.query(
      `INSERT INTO app.ebay_quota_window (resource, window_start, window_end, limit_total)
       VALUES ('buy.browse', now() - interval '1 hour', now() + interval '23 hours', 1000000)`,
    );
    try {
      await checkWorkerRole(roleUrl("worker", WORKER_PASSWORD));

      const window = await database.pool.query<{ used: number }>("SELECT used FROM app.ebay_quota_window");
      expect(window.rows).toEqual([{ used: 0 }]);
    } finally {
      await database.pool.query("DELETE FROM app.ebay_quota_window");
    }
  });

  it("leaves worker without rights on the deletion and audit tables, and fails to connect with a wrong password", async () => {
    await setRolePassword(database.url, "worker", WORKER_PASSWORD);
    const client = await connectAs("worker", WORKER_PASSWORD);
    try {
      for (const statement of [
        "SELECT 1 FROM app.deletion_event",
        "INSERT INTO app.deletion_event (notification_id, topic, event_date, publish_attempt_count) VALUES ('x', 'MARKETPLACE_ACCOUNT_DELETION', now(), 1)",
        "SELECT 1 FROM app.deletion_result_hourly",
        "SELECT 1 FROM app.probe_seen",
        "SELECT 1 FROM app.audit_event",
        "DELETE FROM app.api_usage_hourly",
      ]) {
        await expect(client.query(statement), statement).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await client.end();
    }
    const wrong = "f".repeat(64);

    const error = await rejection(checkWorkerRole(roleUrl("worker", wrong)));

    expect((error as Error).message).toBe("worker role check failed at connect: 28P01");
    expect(JSON.stringify(error)).not.toContain(wrong);
  });

  it.each([
    ["insert poll_run: 42501", "REVOKE INSERT ON app.poll_run FROM worker", "GRANT INSERT ON app.poll_run TO worker"],
    [
      "reserve_ebay_call: 42501",
      "REVOKE UPDATE ON app.ebay_quota_window FROM worker",
      "GRANT UPDATE ON app.ebay_quota_window TO worker",
    ],
    ["pgboss.version: 45", "UPDATE pgboss.version SET version = 45", "UPDATE pgboss.version SET version = 46"],
    ["pgboss.version: 42501", "REVOKE SELECT ON pgboss.version FROM worker", "GRANT SELECT ON pgboss.version TO worker"],
    ["statement_timeout: 5s", "worker statement_timeout 5s", "worker statement_timeout 10s"],
  ])("fails at %s, naming the step and never the password", async (expected, breakIt, restore) => {
    await installQueue();
    await setRolePassword(database.url, "worker", WORKER_PASSWORD);
    await alter(breakIt);
    try {
      const error = await rejection(checkWorkerRole(roleUrl("worker", WORKER_PASSWORD)));

      expect(error).toBeInstanceOf(RoleCheckError);
      expect((error as Error).message).toBe(`worker role check failed at ${expected}`);
      expect(JSON.stringify(error)).not.toContain(WORKER_PASSWORD);
    } finally {
      await alter(restore);
    }
  });
});
