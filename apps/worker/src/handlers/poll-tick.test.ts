import type { JobQueue } from "@ebay-sniper/db/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createItemKey } from "../item-key.js";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { createFakeEbay, createFakeReserve, testSearch } from "../testing/ebay.js";
import { createTestLog } from "../testing/log.js";
import { jobs, resetTables, startTestQueue } from "../testing/queue.js";
import { createPollTickHandler, type PollTickDeps } from "./poll-tick.js";
import { createPollHandler } from "./poll.js";

// 12:00 CEST, inside the day interval, in no sweep slot.
const NOW = new Date("2026-10-21T10:00:00.000Z");

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
});

function setup(at: Date = NOW, overrides: Partial<PollTickDeps> = {}) {
  const clock = createTestClock(at);
  const log = createTestLog();
  const deps: PollTickDeps = { pool: db.pool, queue, clock, claudeCallLimit: 40, log: log.log, ...overrides };
  const job = { id: "tick-1", retryCount: 0, signal: new AbortController().signal };
  return { clock, log, tick: () => createPollTickHandler(deps)({}, job) };
}

describe("poll-tick handler (section 2.3)", () => {
  it("queues a poll for each enabled feed that never polled, and none for a paused feed", async () => {
    await db.admin.query("UPDATE app.feed SET enabled = (id <> 'pc')");
    const { tick } = setup();

    await tick();

    expect(await jobs(db, "poll")).toEqual([{ feedId: "gpu" }, { feedId: "ram" }]);
  });

  it("keeps one queued poll per feed when the tick runs again before the poll started", async () => {
    await db.admin.query("UPDATE app.feed SET enabled = (id = 'gpu')");

    await setup().tick();
    await setup(new Date(NOW.getTime() + 60_000)).tick();

    expect(await jobs(db, "poll")).toEqual([{ feedId: "gpu" }]);
  });

  it("does not queue a feed whose killed poll left a running row, until that row is 5 minutes and 1 second old", async () => {
    await db.admin.query("UPDATE app.feed SET enabled = (id = 'gpu')");
    // A poll that dies inside its request: the process is gone, so nothing finishes the row.
    const ebay = createFakeEbay();
    ebay.respondToSearch(() => new Promise<Response>(() => undefined));
    const poll = createPollHandler({
      pool: db.pool,
      queue,
      clock: createTestClock(NOW),
      reserve: createFakeReserve().reserve,
      createSearch: testSearch(ebay, createTestClock(NOW)),
      itemKey: createItemKey(Buffer.alloc(32, 1).toString("base64")),
      postalCode: "80331",
      log: createTestLog().log,
    });
    void poll({ feedId: "gpu" }, { id: "poll-1", retryCount: 0, signal: new AbortController().signal });
    await expect.poll(() => ebay.searches().length).toBe(1);

    await setup(new Date(NOW.getTime() + 5 * 60_000)).tick();
    const atFiveMinutes = await jobs(db, "poll");
    await setup(new Date(NOW.getTime() + 5 * 60_000 + 1_000)).tick();

    expect(atFiveMinutes).toEqual([]);
    expect(await jobs(db, "poll")).toEqual([{ feedId: "gpu" }]);
    expect((await db.admin.query("SELECT status FROM app.poll_run")).rows).toEqual([{ status: "running" }]);
  });

  it("pauses a feed for 15 minutes after 5 failed runs in a row, a stale running row counted as failed", async () => {
    await db.admin.query("UPDATE app.feed SET enabled = (id = 'gpu')");
    const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
    await db.admin.query(
      `INSERT INTO app.poll_run (feed_id, kind, started_at, finished_at, status, error_kind)
       VALUES ('gpu', 'poll', $1, $1, 'error', 'timeout'), ('gpu', 'poll', $2, $2, 'error', 'timeout'),
              ('gpu', 'poll', $3, $3, 'error', 'http_5xx'), ('gpu', 'poll', $4, $4, 'error', 'network')`,
      [minutesAgo(19), minutesAgo(16), minutesAgo(13), minutesAgo(10)],
    );
    // The newest run crashed 7 minutes ago and is stale.
    await db.admin.query("INSERT INTO app.poll_run (feed_id, kind, started_at, status) VALUES ('gpu', 'poll', $1, 'running')", [
      minutesAgo(7),
    ]);

    await setup().tick();
    const paused = await jobs(db, "poll");
    // The pause runs 15 minutes from the newest of the five.
    await setup(new Date(minutesAgo(7).getTime() + 15 * 60_000)).tick();

    expect(paused).toEqual([]);
    expect(await jobs(db, "poll")).toEqual([{ feedId: "gpu" }]);
  });

  it("queues a segment's sweep in its minute slot once its feed has a baseline, and not before", async () => {
    await db.admin.query("UPDATE app.feed SET enabled = true");
    // gpu has polled its baseline; ram has not.
    await db.admin.query(
      `INSERT INTO app.seen_item (item_key, key_version, feed_id, outcome, first_seen_at, last_seen_at)
       VALUES (repeat('a', 64), 1, 'gpu', 'baseline', $1, $1)`,
      [NOW],
    );
    // 12:05 CEST is the gpu_3090 slot, 12:35 the ram_ddr4 slot.
    await setup(new Date("2026-10-21T10:05:00.000Z")).tick();
    await setup(new Date("2026-10-21T10:35:00.000Z")).tick();

    expect(await jobs(db, "sweep")).toEqual([{ segment: "gpu_3090" }]);
  });

  it("queues nothing and logs the plan when the worst-case daily calls pass 2,500 (section 3.4)", async () => {
    await db.admin.query("UPDATE app.feed SET enabled = true");
    // 40 + 2 listings a day at 3 attempts: 126 getItem units. 300 Claude calls make it 906.
    const { tick, log } = setup(NOW, { claudeCallLimit: 300 });

    await tick();

    expect(await jobs(db, "poll")).toEqual([]);
    expect(log.events("call_plan_refused")).toEqual([
      { event: "call_plan_refused", total: 2694, ceiling: 2500, polls: 1584, overflow_pages: 60, sweeps: 144, get_item: 906 },
    ]);
  });
});
