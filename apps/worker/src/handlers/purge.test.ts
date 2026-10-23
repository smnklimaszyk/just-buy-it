import { createPool } from "@ebay-sniper/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { createTestLog } from "../testing/log.js";
import { resetTables } from "../testing/queue.js";
import { createPurgeHandler } from "./purge.js";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const HOUR_MS = 3_600_000;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await resetTables(db);
});

const job = { id: "purge-1", retryCount: 0, signal: new AbortController().signal };

// A listing confirmed now, with summary content that expires at `expiresAt`.
async function listing(n: number, expiresAt: Date): Promise<void> {
  const result = await db.admin.query<{ id: string }>(
    `INSERT INTO ebay_live.listing (item_key, key_version, item_id, legacy_item_id, feed_id, segment, first_seen_at,
       last_confirmed_at, content_expires_at)
     VALUES ($1, 1, 'v1|1|0', '1', 'gpu', 'gpu_3090', $2, $2, $3) RETURNING id`,
    [n.toString(16).padStart(64, "0"), NOW, expiresAt],
  );
  await db.admin.query(
    `INSERT INTO ebay_live.listing_content (listing_id, source, title, fetched_at, content_expires_at)
     VALUES ($1, 'summary', 'RTX 3090 Founders Edition', $2, $3)`,
    [result.rows[0]?.id, new Date(NOW.getTime() - HOUR_MS), expiresAt],
  );
}

describe("purge handler (section 7.3)", () => {
  it("runs the purge as role worker, records the run and logs its counts, never content", async () => {
    await listing(1, NOW);
    await listing(2, new Date(NOW.getTime() + 1_000));
    const log = createTestLog();
    const purge = createPurgeHandler({ pool: db.pool, clock: createTestClock(NOW), log: log.log });

    await purge({}, job);

    const content = await db.admin.query("SELECT count(*)::int AS n FROM ebay_live.listing_content");
    expect(content.rows).toEqual([{ n: 1 }]);
    const runs = await db.admin.query("SELECT status, counts->>'listing_content' AS deleted FROM app.purge_run");
    expect(runs.rows).toEqual([{ status: "ok", deleted: "1" }]);
    expect(log.events("purge")).toMatchObject([{ event: "purge", status: "ok", counts: { listing_content: 1 } }]);
    expect(log.text()).not.toContain("Founders");
  });

  it("logs a failed v2 step with its SQL state and still finishes the job (spec 2.10)", async () => {
    await db.admin.query("REVOKE DELETE ON auth.rate_counter FROM worker");
    const log = createTestLog();
    try {
      const purge = createPurgeHandler({ pool: db.pool, clock: createTestClock(NOW), log: log.log });

      await purge({}, job);
    } finally {
      await db.admin.query("GRANT DELETE ON auth.rate_counter TO worker");
    }

    expect(log.events("purge_step")).toEqual([{ event: "purge_step", step: "rate_counter", status: "error", sql_state: "42501" }]);
    expect(log.events("purge")).toMatchObject([{ event: "purge", status: "ok", counts: { auth_event: 0 } }]);
  });

  it("logs a failed purge with its SQL state, then fails the job", async () => {
    await listing(1, NOW);
    // As role dashboard: no DELETE on the content tables.
    const url = new URL(db.workerUrl);
    url.searchParams.set("options", "-c role=dashboard");
    const pool = createPool({ connectionString: url.toString(), max: 1, applicationName: "purge-test", onError: () => undefined });
    const log = createTestLog();
    try {
      const purge = createPurgeHandler({ pool, clock: createTestClock(NOW), log: log.log });

      await expect(purge({}, job)).rejects.toThrow("permission denied");
    } finally {
      await pool.end();
    }

    expect(log.events("purge")).toEqual([{ event: "purge", status: "error", sql_state: "42501" }]);
  });
});
