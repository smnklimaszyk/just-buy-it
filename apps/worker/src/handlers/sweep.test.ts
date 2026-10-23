import { saveProductWithPlan, type StoredProduct } from "@ebay-sniper/db";
import type { JobQueue } from "@ebay-sniper/db/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createItemKey } from "../item-key.js";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { createFakeEbay, createFakeReserve, itemSummary, searchPage, testSearch } from "../testing/ebay.js";
import { createTestLog } from "../testing/log.js";
import { jobs, resetTables, startTestQueue } from "../testing/queue.js";
import type { SearchDeps } from "./poll.js";
import { createSweepHandler } from "./sweep.js";

const ITEM_KEY_SECRET = Buffer.alloc(32, 1).toString("base64");
// 12:05 CEST. The handler does not check the minute; poll-tick does.
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
});

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.admin.query(sql, params);
  return result.rows as T[];
}

const listedLongAgo = new Date(NOW.getTime() - 30 * HOUR_MS).toISOString();

// ---- v2: one sweep per product with the price-drop check (spec 5.1, 9) -------------------------

const SETTINGS_ENV = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null };
// Synthetic example product (ADR 0023): a portrait lens in the lens category.
const LENS_CATEGORY = "3323";

async function createProduct(overrides: Record<string, unknown> = {}): Promise<StoredProduct> {
  const result = await saveProductWithPlan(
    db.admin,
    {
      kind: "create",
      fields: {
        name: "Portrait lens",
        description: "An 85 mm portrait lens for a full-frame camera.",
        status: "active",
        categoryId: LENS_CATEGORY,
        conditionIds: ["3000"],
        searchWords: ["85mm"],
        mustWords: [["85mm"]],
        priceMode: "fixed",
        maxCents: 30_000,
        buyerProfile: "private",
        priceDropCheck: true,
        ...overrides,
      },
    },
    // Two days before NOW, so the listings of the tests are after watch_from.
    { at: new Date(NOW.getTime() - 48 * HOUR_MS), actor: "system:cli", userId: null, env: SETTINGS_ENV },
  );
  if (!result.ok) throw new Error(`save refused: ${JSON.stringify(result)}`);
  return result.product;
}

function setupProduct() {
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
    settingsEnv: SETTINGS_ENV,
    log: log.log,
  };
  const job = (signal: AbortSignal = new AbortController().signal) => ({ id: "job-1", retryCount: 0, signal });
  return { clock, ebay, reserve, log, sweep: createSweepHandler(deps), job };
}

describe("sweep handler, per product (spec 5.1)", () => {
  beforeEach(async () => {
    await db.admin.query(
      "TRUNCATE app.product, app.product_source, app.product_revision, app.search, app.search_product, app.market_value CASCADE",
    );
  });

  it("searches the product's band by price with its own words and makes a tracked listing that dropped into it a candidate", async () => {
    const product = await createProduct();
    await db.admin.query(
      `INSERT INTO app.seen_item (item_key, key_version, feed_id, segment, outcome, first_seen_at, last_seen_at)
       VALUES ($1, 1, 's1', $2, 'above_max', $3, $3)`,
      [itemKey("955500001001").itemKey, product.key, new Date(NOW.getTime() - 30 * HOUR_MS)],
    );
    const { ebay, reserve, sweep, job } = setupProduct();
    ebay.searchPages(
      searchPage(
        [
          itemSummary({
            legacyItemId: "955500001001",
            categoryId: LENS_CATEGORY,
            title: "Canon EF 85mm 1.8 USM",
            price: "270.00",
            itemCreationDate: listedLongAgo,
          }),
        ],
        { next: true },
      ),
    );

    await sweep({ productKey: product.key }, job());

    expect(ebay.searches()).toHaveLength(1);
    const url = ebay.searches()[0];
    expect(url?.searchParams.get("q")).toBe("85mm");
    expect(url?.searchParams.get("category_ids")).toBe(LENS_CATEGORY);
    expect(url?.searchParams.get("sort")).toBe("price");
    // The floor is 40 % of the EUR 300 max.
    expect(url?.searchParams.get("filter")).toContain("price:[120..300]");
    expect(reserve.reservations).toEqual([{ resource: "buy.browse", callClass: "standard", purpose: "sweep", minLeft: 1500 }]);
    expect(await rows("SELECT feed_id, segment, source, price_cents, product_version, limit_cents FROM app.candidate")).toEqual([
      { feed_id: product.key, segment: product.key, source: "sweep", price_cents: 27000, product_version: 1, limit_cents: 30000 },
    ]);
    expect(await jobs(db, "enrich")).toHaveLength(1);
    expect(await rows("SELECT feed_id, segment, kind, baseline, status, pages, candidates, calls FROM app.poll_run")).toEqual([
      { feed_id: product.key, segment: product.key, kind: "sweep", baseline: false, status: "ok", pages: 1, candidates: 1, calls: 1 },
    ]);
  });

  it("records an old first sighting as too_old, a recent one as a candidate, and writes no price sample", async () => {
    const product = await createProduct();
    const { ebay, sweep, job } = setupProduct();
    const listing = (legacyItemId: string, itemCreationDate: string) =>
      itemSummary({ legacyItemId, categoryId: LENS_CATEGORY, title: "Canon EF 85mm 1.8 USM", price: "250.00", itemCreationDate });
    ebay.searchPages(
      searchPage([
        listing("955500001101", listedLongAgo),
        listing("955500001102", new Date(NOW.getTime() - HOUR_MS).toISOString()),
      ]),
    );

    await sweep({ productKey: product.key }, job());

    const outcomes = await rows<{ item_key: string; outcome: string }>("SELECT item_key, outcome FROM app.seen_item");
    expect(Object.fromEntries(outcomes.map((r) => [r.item_key, r.outcome]))).toEqual({
      [itemKey("955500001101").itemKey]: "too_old",
      [itemKey("955500001102").itemKey]: "candidate",
    });
    expect(await rows("SELECT count(*)::int AS n FROM app.price_sample")).toEqual([{ n: 0 }]);
  });

  it.each([
    ["paused", { status: "paused" }],
    ["archived", { status: "archived" }],
    ["without the price-drop check", { priceDropCheck: false }],
  ])("records paused and sends nothing for a product %s after the job was queued", async (_name, change) => {
    const product = await createProduct();
    const result = await saveProductWithPlan(
      db.admin,
      { kind: "update", id: product.id, version: product.version, fields: { ...product.rules, ...change } },
      { at: NOW, actor: "system:cli", userId: null, env: SETTINGS_ENV },
    );
    if (!result.ok) throw new Error("save refused");
    const { ebay, reserve, sweep, job } = setupProduct();

    await sweep({ productKey: product.key }, job());

    expect(ebay.requests).toEqual([]);
    expect(reserve.reservations).toEqual([]);
    expect(await rows("SELECT kind, segment, status FROM app.poll_run")).toEqual([{ kind: "sweep", segment: product.key, status: "paused" }]);
  });

  it("sweeps a per-GB product from its floor at the minimum total to its limit at the largest kit", async () => {
    // EUR 3.00 per GB, 64 to 128 GB: the default floor is 40 %, EUR 1.20 per GB.
    const product = await createProduct({
      name: "Memory card",
      description: "A microSD card of 64 GB or more.",
      categoryId: "96991",
      searchWords: ["microsd"],
      mustWords: [["microsd"]],
      perGb: true,
      unitMinTotal: 64,
      unitMaxTotal: 128,
      maxCents: 300,
    });
    const { ebay, sweep, job } = setupProduct();

    await sweep({ productKey: product.key }, job());

    const url = ebay.searches()[0];
    expect(url?.searchParams.get("q")).toBe("microsd");
    expect(url?.searchParams.get("category_ids")).toBe("96991");
    expect(url?.searchParams.get("filter")).toContain("price:[76..384]");
  });
});
