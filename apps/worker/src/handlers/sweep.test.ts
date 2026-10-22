import type { JobQueue } from "@ebay-sniper/db/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createItemKey } from "../item-key.js";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { createFakeEbay, createFakeReserve, gpuSummary, searchPage, testSearch } from "../testing/ebay.js";
import { createTestLog } from "../testing/log.js";
import { jobs, resetTables, startTestQueue } from "../testing/queue.js";
import type { SearchDeps } from "./poll.js";
import { createSweepHandler } from "./sweep.js";

const ITEM_KEY_SECRET = Buffer.alloc(32, 1).toString("base64");
// 12:05 CEST, the gpu_3090 sweep slot.
const NOW = new Date("2026-10-21T10:05:00.000Z");
const HOUR_MS = 3_600_000;
const itemKey = createItemKey(ITEM_KEY_SECRET);

let db: TestDatabase;
let queue: JobQueue;

beforeAll(async () => {
  db = await createTestDatabase();
  queue = await startTestQueue(db);
}, 60_000);

afterAll(async () => {
  await queue.stop({ graceful: false, timeoutMs: 5_000 });
  await db.drop();
});

beforeEach(async () => {
  await resetTables(db);
  await db.admin.query("UPDATE app.feed SET enabled = true");
});

function setup() {
  const clock = createTestClock(NOW);
  const ebay = createFakeEbay();
  const reserve = createFakeReserve();
  const log = createTestLog();
  const deps: SearchDeps = {
    pool: db.pool,
    queue,
    clock,
    reserve: reserve.reserve,
    createSearch: testSearch(ebay, clock),
    itemKey,
    postalCode: "80331",
    log: log.log,
  };
  const job = (signal: AbortSignal = new AbortController().signal) => ({ id: "job-1", retryCount: 0, signal });
  return { clock, ebay, reserve, log, sweep: createSweepHandler(deps), job };
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.admin.query(sql, params);
  return result.rows as T[];
}

// An item the gpu poll saw before, rejected with this outcome.
async function tracked(legacyItemId: string, outcome: string): Promise<void> {
  const seenAt = new Date(NOW.getTime() - 30 * HOUR_MS);
  await db.admin.query(
    `INSERT INTO app.seen_item (item_key, key_version, feed_id, segment, outcome, first_seen_at, last_seen_at)
     VALUES ($1, 1, 'gpu', 'gpu_3090', $2, $3, $3)`,
    [itemKey(legacyItemId).itemKey, outcome, seenAt],
  );
}

const listedLongAgo = new Date(NOW.getTime() - 30 * HOUR_MS).toISOString();

describe("sweep handler (sections 2.3, 3.2)", () => {
  it("searches the segment's own deal band by price and makes a tracked item that dropped into it a candidate", async () => {
    await tracked("955500000500", "above_max");
    const { ebay, sweep, job } = setup();
    ebay.searchPages(
      searchPage([gpuSummary({ legacyItemId: "955500000500", price: "480.00", itemCreationDate: listedLongAgo })], { next: true }),
    );

    await sweep({ segment: "gpu_3090" }, job());

    expect(ebay.searches()).toHaveLength(1);
    const url = ebay.searches()[0];
    expect(url?.searchParams.get("q")).toBe("(3090,rtx3090)");
    expect(url?.searchParams.get("sort")).toBe("price");
    expect(url?.searchParams.get("filter")).toContain("price:[260..520]");
    expect(await rows("SELECT segment, source, price_cents FROM app.candidate")).toEqual([
      { segment: "gpu_3090", source: "sweep", price_cents: 48000 },
    ]);
    expect(await jobs(db, "enrich")).toHaveLength(1);
    expect(await rows("SELECT feed_id, segment, kind, baseline, status, pages, candidates, calls FROM app.poll_run")).toEqual([
      { feed_id: "gpu", segment: "gpu_3090", kind: "sweep", baseline: false, status: "ok", pages: 1, candidates: 1, calls: 1 },
    ]);
  });

  it("records an old first sighting as too_old, a recent one as a candidate, and writes no price sample", async () => {
    const { ebay, sweep, job } = setup();
    ebay.searchPages(
      searchPage([
        gpuSummary({ legacyItemId: "955500000601", price: "400.00", itemCreationDate: listedLongAgo }),
        gpuSummary({ legacyItemId: "955500000602", price: "410.00", itemCreationDate: new Date(NOW.getTime() - HOUR_MS).toISOString() }),
      ]),
    );

    await sweep({ segment: "gpu_3090" }, job());

    const outcomes = await rows<{ item_key: string; outcome: string }>("SELECT item_key, outcome FROM app.seen_item");
    expect(Object.fromEntries(outcomes.map((r) => [r.item_key, r.outcome]))).toEqual({
      [itemKey("955500000601").itemKey]: "too_old",
      [itemKey("955500000602").itemKey]: "candidate",
    });
    expect(await rows("SELECT count(*)::int AS n FROM app.price_sample")).toEqual([{ n: 0 }]);
  });

  it("records paused and sends nothing when the segment rule was switched off after the job was queued", async () => {
    await db.admin.query("UPDATE app.segment_rule SET enabled = false WHERE segment = 'gpu_3090'");
    const { ebay, reserve, sweep, job } = setup();

    await sweep({ segment: "gpu_3090" }, job());

    expect(ebay.requests).toEqual([]);
    expect(reserve.reservations).toEqual([]);
    expect(await rows("SELECT kind, segment, status FROM app.poll_run")).toEqual([{ kind: "sweep", segment: "gpu_3090", status: "paused" }]);
  });

  it("sweeps a per-GB segment up to its max for a 64 GB kit, reserved as purpose sweep", async () => {
    const { ebay, reserve, sweep, job } = setup();

    await sweep({ segment: "ram_ddr5" }, job());

    const url = ebay.searches()[0];
    expect(url?.searchParams.get("q")).toBe("ddr5");
    expect(url?.searchParams.get("category_ids")).toBe("170083");
    expect(url?.searchParams.get("filter")).toContain("price:[89..358]");
    expect(reserve.reservations).toEqual([{ resource: "buy.browse", callClass: "standard", purpose: "sweep", minLeft: 1500 }]);
  });
});
