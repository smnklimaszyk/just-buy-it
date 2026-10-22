import { afterEach, describe, expect, inject, it } from "vitest";
import { setRolePassword } from "../app-role.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { migrateQueue } from "./migrate-queue.js";
import { QueuePayloadError } from "./registry.js";
import { startQueue } from "./start.js";

const adminUrl = inject("testDatabaseAdminUrl");

let databases: TestDatabase[] = [];

async function templateDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase(adminUrl, { from: "template" });
  databases.push(database);
  return database;
}

const WORKER_PASSWORD = "1111111111111111111111111111111111111111111111111111111111111111";
const LISTING_ID = "0199f0a2-7c1e-7b3a-9d4e-2f6a8b0c1d2e";

let errors: Error[] = [];

// A migrated database with the pg-boss schema and queues, and the worker role able to log in.
async function installedDatabase(): Promise<TestDatabase> {
  const database = await templateDatabase();
  const client = await database.pool.connect();
  try {
    await migrateQueue(client);
  } finally {
    client.release();
  }
  await setRolePassword(database.url, "worker", WORKER_PASSWORD);
  return database;
}

function workerUrl(database: TestDatabase): string {
  const url = new URL(database.url);
  url.username = "worker";
  url.password = WORKER_PASSWORD;
  return url.toString();
}

afterEach(async () => {
  await Promise.all(databases.map((database) => database.drop()));
  databases = [];
  errors = [];
});

describe("startQueue (section 2.2)", () => {
  it("refuses to start without the pg-boss schema and installs nothing (A12)", async () => {
    const database = await templateDatabase();
    const errors: Error[] = [];

    await expect(startQueue({ connectionString: database.url, onError: (error) => errors.push(error) })).rejects.toThrow(
      "pg-boss is not installed",
    );
    const schema = await database.pool.query("SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss'");
    expect(schema.rowCount).toBe(0);
  });

  it("starts as worker on the installed schema and hands a sent job's payload to its handler", { timeout: 20_000 }, async () => {
    const database = await installedDatabase();
    const queue = await startQueue({ connectionString: workerUrl(database), onError: (error) => errors.push(error) });
    try {
      const seen: unknown[] = [];
      await queue.work("enrich", async (payload, job) => {
        seen.push({ payload, aborted: job.signal.aborted });
      });

      await queue.send("enrich", { listingId: LISTING_ID });

      await expect.poll(() => seen, { timeout: 10_000 }).toEqual([{ payload: { listingId: LISTING_ID }, aborted: false }]);
    } finally {
      await queue.stop({ graceful: false, timeoutMs: 5_000 });
    }
    expect(errors).toEqual([]);
  });

  it("keeps one queued job per key on an exclusive queue and refuses a payload outside the registry", { timeout: 20_000 }, async () => {
    const database = await installedDatabase();
    const queue = await startQueue({ connectionString: workerUrl(database), onError: (error) => errors.push(error) });
    try {
      expect(await queue.send("poll", { feedId: "gpu" })).toEqual(expect.any(String));
      expect(await queue.send("poll", { feedId: "gpu" })).toBeNull();
      expect(await queue.send("poll", { feedId: "ram" })).toEqual(expect.any(String));
      expect(await queue.send("poll-tick", {})).toEqual(expect.any(String));
      expect(await queue.send("poll-tick", {})).toBeNull();
      const withTitle = { listingId: LISTING_ID, title: "RTX 3090" };
      await expect(queue.send("enrich", withTitle)).rejects.toBeInstanceOf(QueuePayloadError);

      const jobs = await database.pool.query<{ name: string; data: unknown; singleton_key: string | null }>(
        "SELECT name, data, singleton_key FROM pgboss.job ORDER BY name, singleton_key",
      );
      expect(jobs.rows).toEqual([
        { name: "poll", data: { feedId: "gpu" }, singleton_key: "gpu" },
        { name: "poll", data: { feedId: "ram" }, singleton_key: "ram" },
        { name: "poll-tick", data: {}, singleton_key: null },
      ]);
    } finally {
      await queue.stop({ graceful: false, timeoutMs: 5_000 });
    }
  });

  it("registers the cron schedules of the registry in UTC, and reports whether it is started", { timeout: 20_000 }, async () => {
    const database = await installedDatabase();
    const queue = await startQueue({ connectionString: workerUrl(database), onError: (error) => errors.push(error) });
    try {
      expect(queue.isStarted()).toBe(true);

      await queue.schedule();
      await queue.schedule();

      const schedules = await database.pool.query("SELECT name, cron, timezone, data FROM pgboss.schedule ORDER BY name");
      expect(schedules.rows).toEqual([
        { name: "poll-tick", cron: "* * * * *", timezone: "UTC", data: {} },
        { name: "purge", cron: "*/15 * * * *", timezone: "UTC", data: {} },
        { name: "relay", cron: "* * * * *", timezone: "UTC", data: {} },
      ]);
    } finally {
      await queue.stop({ graceful: false, timeoutMs: 5_000 });
    }
    expect(queue.isStarted()).toBe(false);
  });

  it("enqueues on the caller's client inside its transaction, so a rollback leaves no job (section 2.4)", { timeout: 20_000 }, async () => {
    const database = await installedDatabase();
    const queue = await startQueue({ connectionString: workerUrl(database), onError: (error) => errors.push(error) });
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      expect(await queue.send("enrich", { listingId: LISTING_ID }, { db: client })).toEqual(expect.any(String));
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await queue.send("screen", { listingId: LISTING_ID }, { db: client });
      await client.query("COMMIT");

      const jobs = await database.pool.query<{ name: string }>("SELECT name FROM pgboss.job ORDER BY name");
      expect(jobs.rows).toEqual([{ name: "screen" }]);
    } finally {
      client.release();
      await queue.stop({ graceful: false, timeoutMs: 5_000 });
    }
  });
});
