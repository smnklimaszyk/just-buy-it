import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { AppRoleCheckError, checkAppRole, setAppRolePassword } from "./app-role.js";
import { runMigrations } from "./migrate.js";
import { MigrateLockTimeoutError, ROLE_LOCK_KEY, withRoleLock } from "./role-lock.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// The role app is cluster-wide: every test database on the test server shares it, so the tests
// use one fixed password and change the role only under the role lock.

const adminUrl = inject("testDatabaseAdminUrl");
const APP_PASSWORD = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

function appUrl(password: string): string {
  const url = new URL(database.url);
  url.username = "app";
  url.password = password;
  return url.toString();
}

async function connectAsApp(password: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: appUrl(password) });
  client.on("error", () => undefined);
  await client.connect();
  return client;
}

async function connectError(password: string): Promise<unknown> {
  try {
    const client = await connectAsApp(password);
    await client.end();
  } catch (error) {
    return error;
  }
  throw new Error("expected the connection as app to fail");
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

// Puts the role back to how migration 0003 creates it.
async function resetAppRole(): Promise<void> {
  await withRoleLock(adminUrl, { attempts: 120, retryMs: 50 }, async () => {
    await database.pool.query("ALTER ROLE app NOLOGIN PASSWORD NULL");
  });
}

describe("migration 0003_app_role", () => {
  it("creates the role app without superuser, CREATEDB or CREATEROLE", async () => {
    const result = await database.pool.query<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
      "SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'app'",
    );

    expect(result.rows).toEqual([{ rolsuper: false, rolcreatedb: false, rolcreaterole: false }]);
  });
});

describe("setAppRolePassword", () => {
  it("gives app LOGIN and a SCRAM verifier, so a session with the password works", async () => {
    await resetAppRole();
    // With no password stored, authentication fails before the LOGIN check.
    expect(await connectError(APP_PASSWORD)).toMatchObject({ code: "28P01" });

    await setAppRolePassword(database.url, APP_PASSWORD);

    const role = await database.pool.query<{ rolcanlogin: boolean; rolpassword: string }>(
      "SELECT rolcanlogin, rolpassword FROM pg_authid WHERE rolname = 'app'",
    );
    expect(role.rows[0]?.rolcanlogin).toBe(true);
    expect(role.rows[0]?.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
    const client = await connectAsApp(APP_PASSWORD);
    await client.end();
  });

  it("is needed for LOGIN: migrating another database never lets app log in", async () => {
    await setAppRolePassword(database.url, APP_PASSWORD);
    await withRoleLock(adminUrl, { attempts: 120, retryMs: 50 }, async () => {
      await database.pool.query("ALTER ROLE app NOLOGIN");
    });
    const other = await createTestDatabase(adminUrl, { from: "empty" });
    try {
      await runMigrations({ connectionString: other.url, log: () => undefined });

      expect(await connectError(APP_PASSWORD)).toMatchObject({ code: "28000" });
      await setAppRolePassword(database.url, APP_PASSWORD);
      const client = await connectAsApp(APP_PASSWORD);
      await client.end();
    } finally {
      await other.drop();
    }
  });

  it("never sends the plaintext password in a statement", async () => {
    const query = vi.spyOn(pg.Client.prototype, "query");
    try {
      await setAppRolePassword(database.url, APP_PASSWORD);

      expect(query).toHaveBeenCalled();
      const sent = query.mock.calls.map((call) => JSON.stringify(call)).join("\n");
      expect(sent).toContain("SCRAM-SHA-256$4096:");
      expect(sent).not.toContain(APP_PASSWORD);
    } finally {
      query.mockRestore();
    }
  });
});

describe("privileges of app", () => {
  it("can read, insert and update the four server tables and nothing more", async () => {
    await setAppRolePassword(database.url, APP_PASSWORD);
    const hour = new Date("2026-10-20T10:00:00Z");
    const client = await connectAsApp(APP_PASSWORD);
    try {
      await client.query(
        "INSERT INTO app.deletion_event (notification_id, topic, event_date, publish_attempt_count) VALUES ('grant-check', 'MARKETPLACE_ACCOUNT_DELETION', $1, 1)",
        [hour],
      );
      await client.query("UPDATE app.deletion_event SET publish_attempt_count = 2 WHERE notification_id = 'grant-check'");
      await client.query("INSERT INTO app.deletion_result_hourly (hour_utc, result, notifications) VALUES ($1, 'dropped', 1)", [hour]);
      await client.query("UPDATE app.deletion_result_hourly SET notifications = 2 WHERE hour_utc = $1", [hour]);
      await client.query(
        "INSERT INTO app.api_usage_hourly (hour_utc, resource, purpose, calls) VALUES ($1, 'identity.oauth2', 'token', 1)",
        [hour],
      );
      await client.query("UPDATE app.api_usage_hourly SET calls = 2 WHERE hour_utc = $1", [hour]);
      await client.query("INSERT INTO app.probe_seen (id, seen_at) VALUES (1, $1)", [hour]);
      await client.query("UPDATE app.probe_seen SET seen_at = $1", [hour]);

      for (const statement of [
        "DELETE FROM app.deletion_event",
        "TRUNCATE app.deletion_result_hourly",
        "CREATE TABLE app.x (id integer)",
        "UPDATE app.ebay_quota_window SET used = used",
        "SELECT * FROM drizzle.__drizzle_migrations",
      ]) {
        await expect(client.query(statement), statement).rejects.toMatchObject({ code: "42501" });
      }
      const timeout = await client.query<{ statement_timeout: string }>("SHOW statement_timeout");
      expect(timeout.rows[0]?.statement_timeout).toBe("2s");
    } finally {
      await client.end();
    }
  });
});

describe("role lock", () => {
  it("lets five databases of one cluster migrate and set the password in parallel", { timeout: 60_000 }, async () => {
    const others = await Promise.all(
      Array.from({ length: 5 }, () => createTestDatabase(adminUrl, { from: "empty" })),
    );
    try {
      // Each run holds the role lock for its whole Drizzle step (about 1.5 s with the v2
      // migrations), so the fifth waits about four of them: 120 tries 100 ms apart cover that.
      await Promise.all(
        others.map((other) => runMigrations({ connectionString: other.url, log: () => undefined, lockRetryMs: 100 })),
      );
      await Promise.all(others.map((other) => setAppRolePassword(other.url, APP_PASSWORD, { lockRetryMs: 100 })));

      const client = await connectAsApp(APP_PASSWORD);
      await client.end();
    } finally {
      await Promise.all(others.map((other) => other.drop()));
    }
  });

  it("gives up with MigrateLockTimeoutError while another session holds the role lock", async () => {
    const postgresUrl = new URL(adminUrl);
    postgresUrl.pathname = "/postgres";
    const holder = new pg.Client({ connectionString: postgresUrl.toString() });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [ROLE_LOCK_KEY.toString()]);

      await expect(
        setAppRolePassword(database.url, APP_PASSWORD, { lockAttempts: 2, lockRetryMs: 20 }),
      ).rejects.toBeInstanceOf(MigrateLockTimeoutError);
    } finally {
      await holder.end();
    }
  });
});

describe("checkAppRole", () => {
  it("passes as app and leaves the four tables empty", async () => {
    await database.pool.query("TRUNCATE app.deletion_event, app.deletion_result_hourly, app.api_usage_hourly, app.probe_seen");
    await setAppRolePassword(database.url, APP_PASSWORD);

    await checkAppRole(appUrl(APP_PASSWORD));

    const counts = await database.pool.query<{ events: number; results: number; usage: number; probes: number }>(
      `SELECT (SELECT count(*)::int FROM app.deletion_event) AS events,
              (SELECT count(*)::int FROM app.deletion_result_hourly) AS results,
              (SELECT count(*)::int FROM app.api_usage_hourly) AS usage,
              (SELECT count(*)::int FROM app.probe_seen) AS probes`,
    );
    expect(counts.rows[0]).toEqual({ events: 0, results: 0, usage: 0, probes: 0 });
  });

  it("names the step and the SQLSTATE when a grant is missing, never the password", async () => {
    await setAppRolePassword(database.url, APP_PASSWORD);
    await database.pool.query("REVOKE INSERT ON app.deletion_event FROM app");
    try {
      const error = await rejection(checkAppRole(appUrl(APP_PASSWORD)));

      expect(error).toBeInstanceOf(AppRoleCheckError);
      expect((error as Error).message).toBe("app role check failed at recordDeletionEvent insert: 42501");
      expect(JSON.stringify(error)).not.toContain(APP_PASSWORD);
    } finally {
      await database.pool.query("GRANT INSERT ON app.deletion_event TO app");
    }
  });

  it("names the connect step when the password is wrong, never the password", async () => {
    await setAppRolePassword(database.url, APP_PASSWORD);
    const wrong = "f".repeat(64);

    const error = await rejection(checkAppRole(appUrl(wrong)));

    expect(error).toBeInstanceOf(AppRoleCheckError);
    expect((error as Error).message).toBe("app role check failed at connect: 28P01");
    expect(JSON.stringify(error)).not.toContain(wrong);
    expect((error as Error).message).not.toContain(wrong);
  });

  it("fails when an app session does not run with the 2 s statement timeout", async () => {
    await setAppRolePassword(database.url, APP_PASSWORD);
    const name = new URL(database.url).pathname.slice(1);
    const setTimeoutInDatabase = (value: string) =>
      withRoleLock(adminUrl, { attempts: 120, retryMs: 50 }, async () => {
        await database.pool.query(`ALTER ROLE app IN DATABASE ${name} SET statement_timeout = '${value}'`);
      });
    await setTimeoutInDatabase("5s");
    try {
      await expect(checkAppRole(appUrl(APP_PASSWORD))).rejects.toThrow(
        new AppRoleCheckError("app role check failed at statement_timeout: 5s"),
      );
    } finally {
      await setTimeoutInDatabase("2s");
    }
  });
});

