import { saveProductWithPlan, type StoredProduct } from "@ebay-sniper/db";
import type { JobQueue } from "@ebay-sniper/db/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createItemKey } from "../item-key.js";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { createFakeEbay, createFakeReserve, itemSummary, json, searchPage, testSearch } from "../testing/ebay.js";
import { createTestLog } from "../testing/log.js";
import { resetTables, startTestQueue } from "../testing/queue.js";
import { createPollTickHandler, type PollTickDeps } from "./poll-tick.js";
import { createPollHandler, type SearchDeps } from "./poll.js";
import { createSweepHandler } from "./sweep.js";

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

describe("poll-tick handler, the plan backstop (spec 5.3)", () => {
  beforeEach(async () => {
    await db.admin.query(
      "TRUNCATE app.product, app.product_source, app.product_revision, app.search, app.search_product, app.setting CASCADE",
    );
  });

  it("queues no poll and logs the plan when the stored searches plan more than 2,500 calls a day", async () => {
    await createProduct();
    await createProduct({ name: "Road bike", categoryId: "177831", searchWords: ["rennrad"], mustWords: [["rennrad"]] });
    // Hand-written SQL past the save check: both searches every minute, 1,440 polls a day each.
    await db.admin.query("UPDATE app.search SET day_interval_s = 60, night_interval_s = 60");
    const { tick, sent, log } = setupTick();

    await tick();

    expect(sent).toEqual([]);
    // 126 getItem units for 40 Claude calls; 3 market calls for each of the 2 products plus 60.
    expect(log.events("call_plan_refused")).toEqual([
      { event: "call_plan_refused", total: 3092, ceiling: 2500, polls: 2880, overflow: 20, sweeps: 0, get_item: 126, market: 66 },
    ]);
  });
});

// ---- v2: polls per app.search, sweeps per product (spec 5.1, 9) -------------------------------

const SETTINGS_ENV = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null };

// Synthetic example products (ADR 0023).
function productFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Portrait lens",
    description: "An 85 mm portrait lens for a full-frame camera.",
    status: "active",
    categoryId: "3323",
    conditionIds: ["3000"],
    searchWords: ["85mm"],
    mustWords: [["85mm"]],
    priceMode: "fixed",
    maxCents: 30_000,
    buyerProfile: "private",
    ...overrides,
  };
}

async function createProduct(overrides: Record<string, unknown> = {}): Promise<StoredProduct> {
  const result = await saveProductWithPlan(
    db.admin,
    { kind: "create", fields: productFields(overrides) },
    { at: new Date(NOW.getTime() - 3_600_000), actor: "system:cli", userId: null, env: SETTINGS_ENV },
  );
  if (!result.ok) throw new Error(`save refused: ${JSON.stringify(result)}`);
  return result.product;
}

async function searchOf(product: StoredProduct): Promise<string> {
  const result = await db.admin.query<{ search_id: string }>("SELECT search_id FROM app.search_product WHERE product_id = $1", [
    product.id,
  ]);
  const id = result.rows[0]?.search_id;
  if (id === undefined) throw new Error("product has no search");
  return id;
}

// Keeps what poll-tick sends, in order, instead of writing pg-boss jobs.
function recordingQueue() {
  const sent: { name: string; payload: unknown }[] = [];
  const recorder: Pick<JobQueue, "send"> = {
    async send(name, payload) {
      sent.push({ name, payload });
      return `job-${sent.length}`;
    },
  };
  return { sent, recorder };
}

function setupTick(at: Date = NOW, overrides: Partial<PollTickDeps> = {}) {
  const clock = createTestClock(at);
  const log = createTestLog();
  const { sent, recorder } = recordingQueue();
  const requests: Date[] = [];
  const deps: PollTickDeps = {
    pool: db.pool,
    queue: recorder,
    clock,
    settingsEnv: SETTINGS_ENV,
    queueRequests: async (now) => {
      requests.push(now);
    },
    log: log.log,
    ...overrides,
  };
  const job = { id: "tick-1", retryCount: 0, signal: new AbortController().signal };
  return { clock, log, sent, requests, tick: () => createPollTickHandler(deps)({}, job) };
}

describe("poll-tick handler, searches and products (spec 9)", () => {
  beforeEach(async () => {
    await db.admin.query(
      "TRUNCATE app.product, app.product_source, app.product_revision, app.search, app.search_product, app.setting CASCADE",
    );
  });

  it("queues a poll for each enabled search that never polled, and none for a search of paused products only", async () => {
    const lens = await createProduct();
    const paused = await createProduct({ name: "Road bike", categoryId: "177831", searchWords: ["rennrad"], mustWords: [["rennrad"]] });
    const pause = await saveProductWithPlan(
      db.admin,
      { kind: "update", id: paused.id, version: paused.version, fields: { ...paused.rules, status: "paused" } },
      { at: NOW, actor: "system:cli", userId: null, env: SETTINGS_ENV },
    );
    if (!pause.ok) throw new Error("save refused");
    const { tick, sent } = setupTick();

    await tick();

    expect(sent).toEqual([{ name: "poll", payload: { searchId: await searchOf(lens) } }]);
  });

  it("queues a product's sweep in its own minute, only with the price-drop check", async () => {
    const swept = await createProduct({ priceDropCheck: true });
    await createProduct({ name: "Wide-angle lens", searchWords: ["16mm"], mustWords: [["16mm"]] });
    const minute = new Date(NOW.getTime() + swept.sweepMinute * 60_000);
    // The searches polled a minute ago, so only sweeps can be due.
    await db.admin.query(
      "INSERT INTO app.poll_run (feed_id, kind, started_at, finished_at, status) SELECT id, 'poll', $1, $1, 'ok' FROM app.search",
      [new Date(minute.getTime() - 60_000)],
    );

    const atSlot = setupTick(minute);
    await atSlot.tick();
    const nextMinute = setupTick(new Date(minute.getTime() + 60_000));
    await nextMinute.tick();

    expect(atSlot.sent).toEqual([{ name: "sweep", payload: { productKey: swept.key } }]);
    expect(nextMinute.sent).toEqual([]);
  });

  it("turns open market and category requests into jobs on every tick, also while the plan refuses polls", async () => {
    await createProduct();
    await createProduct({ name: "Road bike", categoryId: "177831", searchWords: ["rennrad"], mustWords: [["rennrad"]] });
    const ok = setupTick();
    await ok.tick();
    await db.admin.query("UPDATE app.search SET day_interval_s = 60, night_interval_s = 60");
    const refused = setupTick(new Date(NOW.getTime() + 60_000));
    await refused.tick();

    expect(ok.requests).toEqual([NOW]);
    expect(refused.log.events("call_plan_refused")).toHaveLength(1);
    expect(refused.requests).toEqual([new Date(NOW.getTime() + 60_000)]);
  });

  it("pauses a search for 15 minutes after 5 failed polls in a row, a stale running row counted as failed", async () => {
    const searchId = await searchOf(await createProduct());
    const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
    await db.admin.query(
      `INSERT INTO app.poll_run (feed_id, kind, started_at, finished_at, status, error_kind)
       VALUES ($1, 'poll', $2, $2, 'error', 'timeout'), ($1, 'poll', $3, $3, 'error', 'timeout'),
              ($1, 'poll', $4, $4, 'error', 'http_5xx'), ($1, 'poll', $5, $5, 'error', 'network')`,
      [searchId, minutesAgo(19), minutesAgo(16), minutesAgo(13), minutesAgo(10)],
    );
    // The newest poll crashed 7 minutes ago and is stale.
    await db.admin.query("INSERT INTO app.poll_run (feed_id, kind, started_at, status) VALUES ($1, 'poll', $2, 'running')", [
      searchId,
      minutesAgo(7),
    ]);

    const paused = setupTick();
    await paused.tick();
    const after = setupTick(new Date(minutesAgo(7).getTime() + 15 * 60_000));
    await after.tick();

    expect(paused.sent).toEqual([]);
    expect(after.sent).toEqual([{ name: "poll", payload: { searchId } }]);
  });
});

describe("poll-tick over a simulated Berlin day (spec 5.2)", () => {
  beforeEach(async () => {
    await db.admin.query(
      "TRUNCATE app.product, app.product_source, app.product_revision, app.search, app.search_product, app.setting CASCADE",
    );
  });

  it("keeps the eBay reservations of polls and sweeps by purpose within the planned calls of the day", async () => {
    // Two lenses at normal speed share one search; a road bike at fast speed has its own.
    // Two price-drop checks.
    await createProduct({ priceDropCheck: true });
    await createProduct({ name: "Wide-angle lens", searchWords: ["16mm"], mustWords: [["16mm"]] });
    await createProduct({
      name: "Road bike",
      categoryId: "177831",
      searchWords: ["rennrad"],
      mustWords: [["rennrad"]],
      speed: "fast",
      priceDropCheck: true,
    });
    // Spec 5.2: polls 240 + 528, overflow 10 per search, sweeps 24 per product with the check.
    const planned = { polls: 768, overflow: 20, sweeps: 48 };

    const clock = createTestClock(new Date("2026-10-20T22:00:00.000Z"));
    const ebay = createFakeEbay();
    const reserve = createFakeReserve();
    // Every answer is a page of one listing no product matches, unseen and with a next page, so
    // each poll asks for overflow pages until the daily overflow is used up.
    ebay.respondToSearch(
      ...Array.from({ length: 1_200 }, () => () => json(searchPage([itemSummary({ title: "Reisestativ Aluminium", price: "150.00" })], { next: true }))),
    );
    const { sent, recorder } = recordingQueue();
    const search: SearchDeps = {
      pool: db.pool,
      queue: recorder,
      clock,
      reserve: reserve.reserve,
      createSearch: testSearch(ebay, clock),
      itemKey: createItemKey(Buffer.alloc(32, 1).toString("base64")),
      postalCode: "80331",
      settingsEnv: SETTINGS_ENV,
      log: createTestLog().log,
    };
    const tick = createPollTickHandler({
      pool: db.pool,
      queue: recorder,
      clock,
      settingsEnv: SETTINGS_ENV,
      queueRequests: async () => undefined,
      log: createTestLog().log,
    });
    const poll = createPollHandler(search);
    const sweep = createSweepHandler(search);
    const job = { id: "job", retryCount: 0, signal: new AbortController().signal };

    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const queued = sent.length;
      await tick({}, job);
      for (const { name, payload } of sent.slice(queued)) {
        if (name === "poll") await poll(payload as { searchId: string }, job);
        if (name === "sweep") await sweep(payload as { productKey: string }, job);
      }
      clock.advance(60_000);
    }

    const byPurpose = (purpose: string) => reserve.reservations.filter((r) => r.purpose === purpose).length;
    const overflow = await db.admin.query<{ pages: number }>(
      "SELECT coalesce(sum(pages - 1), 0)::int AS pages FROM app.poll_run WHERE kind = 'poll'",
    );
    // The plan is the worst case and this day meets it: every planned poll, sweep and overflow page.
    expect(sent.filter((s) => s.name === "poll")).toHaveLength(planned.polls);
    expect(overflow.rows[0]?.pages).toBe(planned.overflow);
    expect(byPurpose("poll")).toBe(planned.polls + planned.overflow);
    expect(byPurpose("sweep")).toBe(planned.sweeps);
    expect(reserve.reservations.every((r) => r.purpose === "poll" || r.purpose === "sweep")).toBe(true);
  }, 300_000);
});
