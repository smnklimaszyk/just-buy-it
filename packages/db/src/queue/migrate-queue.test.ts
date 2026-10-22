import { readFileSync } from "node:fs";
import pg from "pg";
import { afterEach, describe, expect, inject, it } from "vitest";
import { MIGRATE_LOCK_KEY, runMigrations } from "../migrate.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { migrateQueue, PGBOSS_SCHEMA_VERSION, QueueSchemaVersionError } from "./migrate-queue.js";
import { pgBossQueues } from "./registry.js";

const adminUrl = inject("testDatabaseAdminUrl");

let databases: TestDatabase[] = [];

async function migratedDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase(adminUrl, { from: "template" });
  databases.push(database);
  return database;
}

async function withClient<T>(database: TestDatabase, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

afterEach(async () => {
  await Promise.all(databases.map((database) => database.drop()));
  databases = [];
});

describe("migrateQueue (section 2.2)", () => {
  it("installs pg-boss schema 46 into a fresh database, owned by worker", async () => {
    const database = await migratedDatabase();

    const result = await withClient(database, (client) => migrateQueue(client));

    expect(result).toMatchObject({ schemaCreated: true, version: 46 });
    const version = await database.pool.query<{ version: number }>("SELECT version FROM pgboss.version");
    expect(version.rows).toEqual([{ version: 46 }]);
    const owners = await database.pool.query<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(owner) AS owner FROM (
         SELECT nspowner AS owner FROM pg_namespace WHERE nspname = 'pgboss'
         UNION ALL SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'pgboss'
         UNION ALL SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'pgboss'
         UNION ALL SELECT t.typowner FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'pgboss'
       ) objects`,
    );
    expect(owners.rows).toEqual([{ owner: "worker" }]);
  });

  it("expects the schema version of the installed pg-boss package", () => {
    const manifest = new URL("../package.json", import.meta.resolve("pg-boss"));
    const pgBoss = JSON.parse(readFileSync(manifest, "utf8")) as { version: string; pgboss: { schema: number } };

    expect(pgBoss.version).toBe("12.38.0");
    expect(PGBOSS_SCHEMA_VERSION).toBe(pgBoss.pgboss.schema);
  });

  it("leaves no index invalid: a fresh install has no async index builds", async () => {
    const database = await migratedDatabase();
    await withClient(database, (client) => migrateQueue(client));

    const indexes = await database.pool.query<{ total: number; invalid: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT i.indisvalid)::int AS invalid
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pgboss'`,
    );
    expect(indexes.rows[0]?.total).toBeGreaterThan(0);
    expect(indexes.rows[0]?.invalid).toBe(0);
  });

  it("does nothing on a second run", async () => {
    const database = await migratedDatabase();
    await withClient(database, (client) => migrateQueue(client));

    const second = await withClient(database, (client) => migrateQueue(client));

    expect(second).toMatchObject({ schemaCreated: false, version: 46 });
  });

  it("creates the queues of the registry as worker, and on a later run only the missing ones", async () => {
    const database = await migratedDatabase();

    const first = await withClient(database, (client) => migrateQueue(client));

    expect(first.queuesCreated).toEqual(pgBossQueues().map((queue) => queue.name));
    const rows = await database.pool.query(
      `SELECT name, policy, retry_limit, retry_delay, expire_seconds, retention_seconds, deletion_seconds, dead_letter
         FROM pgboss.queue WHERE name IN ('poll', 'screen', 'screen.dead') ORDER BY name`,
    );
    expect(rows.rows).toEqual([
      { name: "poll", policy: "exclusive", retry_limit: 0, retry_delay: 0, expire_seconds: 150, retention_seconds: 21600, deletion_seconds: 3600, dead_letter: "poll.dead" },
      { name: "screen", policy: "standard", retry_limit: 1, retry_delay: 30, expire_seconds: 180, retention_seconds: 21600, deletion_seconds: 3600, dead_letter: "screen.dead" },
      { name: "screen.dead", policy: "standard", retry_limit: 0, retry_delay: 0, expire_seconds: 900, retention_seconds: 21600, deletion_seconds: 3600, dead_letter: null },
    ]);

    await database.pool.query("SELECT pgboss.delete_queue('relay')");
    const later = await withClient(database, (client) => migrateQueue(client));
    expect(later).toEqual({ schemaCreated: false, version: 46, queuesCreated: ["relay"] });
  });

  it("runs as the post-Drizzle step of runMigrations, under the migrate lock", async () => {
    const database = await createTestDatabase(adminUrl, { from: "empty" });
    databases.push(database);
    const steps: string[] = [];
    let lockFree: boolean | undefined;

    await runMigrations({
      connectionString: database.url,
      log: (entry) => steps.push(entry.step),
      afterDrizzle: async (client, logStep) => {
        const other = await database.pool.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
          MIGRATE_LOCK_KEY.toString(),
        ]);
        lockFree = other.rows[0]?.locked;
        const result = await migrateQueue(client);
        logStep("pgboss_installed", { version: result.version });
      },
    });

    expect(lockFree).toBe(false);
    expect(steps).toEqual(["lock_acquired", "history", "role_lock_acquired", "drizzle", "pgboss_installed", "done"]);
    const version = await database.pool.query<{ version: number }>("SELECT version FROM pgboss.version");
    expect(version.rows).toEqual([{ version: 46 }]);
  });

  it("throws the install's own error, keeps nothing of it and resets the session role", async () => {
    const database = await migratedDatabase();
    // A schema of that name the worker does not own: the plan, run as worker, is refused.
    await database.pool.query("CREATE SCHEMA pgboss");

    await withClient(database, async (client) => {
      await expect(migrateQueue(client)).rejects.toMatchObject({ code: "42501" });
      const session = await client.query<{ user: string; in_transaction: boolean }>(
        "SELECT current_user AS user, now() <> statement_timestamp() AS in_transaction",
      );
      expect(session.rows[0]).toEqual({ user: "postgres", in_transaction: false });
    });
    const tables = await database.pool.query("SELECT 1 FROM pg_tables WHERE schemaname = 'pgboss'");
    expect(tables.rowCount).toBe(0);
  });

  it("fails runMigrations with the post-Drizzle step's error and frees the migrate lock", async () => {
    const database = await migratedDatabase();
    await withClient(database, (client) => migrateQueue(client));
    await database.pool.query("UPDATE pgboss.version SET version = 45");

    await expect(
      runMigrations({ connectionString: database.url, log: () => undefined, afterDrizzle: (client) => migrateQueue(client).then(() => undefined) }),
    ).rejects.toBeInstanceOf(QueueSchemaVersionError);
    const lock = await database.pool.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
      MIGRATE_LOCK_KEY.toString(),
    ]);
    expect(lock.rows[0]?.locked).toBe(true);
  });

  it.each([
    [45, "pg-boss schema 45 needs an upgrade path; not built in the MVP"],
    [47, "pg-boss schema 47: database is newer than this release"],
  ])("stops on installed schema %i", async (installed, message) => {
    const database = await migratedDatabase();
    await withClient(database, (client) => migrateQueue(client));
    await database.pool.query("UPDATE pgboss.version SET version = $1", [installed]);

    await expect(withClient(database, (client) => migrateQueue(client))).rejects.toThrow(
      new QueueSchemaVersionError(message),
    );
  });
});
