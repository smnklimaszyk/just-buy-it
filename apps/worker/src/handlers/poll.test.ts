import { saveProductWithPlan, type StoredProduct } from "@ebay-sniper/db";
import type { JobQueue } from "@ebay-sniper/db/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createItemKey } from "../item-key.js";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import {
  createFakeEbay,
  createFakeReserve,
  hang,
  itemSummary,
  searchPage,
  testSearch,
  type SummaryFields,
} from "../testing/ebay.js";
import { createTestLog } from "../testing/log.js";
import { jobs, resetTables, startTestQueue } from "../testing/queue.js";
import { createPollHandler, type SearchDeps } from "./poll.js";

const ITEM_KEY_SECRET = Buffer.alloc(32, 1).toString("base64");
// 12:00 CEST, inside the day interval.
const NOW = new Date("2026-10-21T10:00:00.000Z");
const HOUR_MS = 3_600_000;

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
  await resetProducts();
});

function setup(overrides: Partial<SearchDeps> = {}) {
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
    itemKey: createItemKey(ITEM_KEY_SECRET),
    postalCode: "80331",
    settingsEnv: SETTINGS_ENV,
    log: log.log,
    ...overrides,
  };
  const job = (signal: AbortSignal = new AbortController().signal) => ({ id: "job-1", retryCount: 0, signal });
  return { clock, ebay, reserve, log, deps, poll: createPollHandler(deps), job };
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.admin.query(sql, params);
  return result.rows as T[];
}

const recent = () => new Date(NOW.getTime() - HOUR_MS).toISOString();

// ---- v2: polls per app.search, matched against the search's products (spec 5.1, 5.5, 9) --------

const SETTINGS_ENV = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null };
// Synthetic example product (ADR 0023): a portrait lens in the lens category.
const LENS_CATEGORY = "3323";

function lensFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

// Saved the way the form saves it, two hours before NOW by default, so watch_from is NOW - 2 h.
async function createProduct(overrides: Record<string, unknown> = {}, at = new Date(NOW.getTime() - 2 * HOUR_MS)) {
  const result = await saveProductWithPlan(
    db.admin,
    { kind: "create", fields: lensFields(overrides) },
    { at, actor: "system:cli", userId: null, env: SETTINGS_ENV },
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

async function resetProducts(): Promise<void> {
  await db.admin.query(
    `TRUNCATE app.product, app.product_source, app.product_revision, app.search, app.search_product, app.setting,
       app.market_value, app.market_request CASCADE`,
  );
}

function setupSearch(overrides: Partial<SearchDeps> = {}) {
  return setup({ settingsEnv: SETTINGS_ENV, ...overrides });
}

const lens = (fields: SummaryFields = {}) =>
  itemSummary({ categoryId: LENS_CATEGORY, title: "Canon EF 85mm 1.8 USM", price: "250.00", itemCreationDate: recent(), ...fields });

describe("poll handler, one search of the products (spec 5.1, 9)", () => {
  it("makes an in-band listing a candidate of its product, with the rules it passed, its listing and an enrich job", async () => {
    const product = await createProduct();
    const searchId = await searchOf(product);
    const { ebay, poll, job, log } = setupSearch();
    ebay.searchPages(searchPage([lens({ shipping: "10.00" }), lens({ price: "400.00" })]));

    await poll({ searchId }, job());

    const candidates = await rows<{ listing_id: string }>(
      `SELECT listing_id, feed_id, segment, source, price_cents, landed_cents, rule_version, product_version, match_version,
              condition_group, limit_cents, price_mode, market_value_id, decision
         FROM app.candidate`,
    );
    expect(candidates).toEqual([
      {
        listing_id: expect.any(String),
        feed_id: searchId,
        segment: product.key,
        source: "poll",
        price_cents: 25000,
        landed_cents: 26000,
        rule_version: product.version,
        product_version: product.version,
        match_version: product.matchVersion,
        condition_group: "used",
        limit_cents: 30000,
        price_mode: "fixed",
        market_value_id: null,
        decision: "pending",
      },
    ]);
    const listingId = candidates[0]?.listing_id;
    expect(await rows("SELECT id, feed_id, segment FROM ebay_live.listing")).toEqual([
      { id: listingId, feed_id: searchId, segment: product.key },
    ]);
    expect(await jobs(db, "enrich")).toEqual([{ listingId }]);
    expect(await rows("SELECT feed_id, segment, outcome FROM app.seen_item ORDER BY outcome")).toEqual([
      { feed_id: searchId, segment: product.key, outcome: "above_max" },
      { feed_id: searchId, segment: product.key, outcome: "candidate" },
    ]);
    expect(await rows("SELECT feed_id, kind, baseline, status, pages, items, new_items, candidates, calls FROM app.poll_run")).toEqual([
      { feed_id: searchId, kind: "poll", baseline: false, status: "ok", pages: 1, items: 2, new_items: 2, candidates: 1, calls: 1 },
    ]);
    expect(log.events("candidate_created")).toEqual([
      { event: "candidate_created", listing_id: listingId, segment: product.key, source: "poll" },
    ]);
    const [url] = ebay.searches();
    expect(Object.fromEntries(url?.searchParams ?? [])).toMatchObject({
      q: "85mm",
      category_ids: LENS_CATEGORY,
      sort: "newlyListed",
      offset: "0",
    });
  });

  it("gives a listing that matches two products of the search to the most specific one", async () => {
    const anyBrand = await createProduct({ name: "Portrait lens" });
    const canon = await createProduct({ name: "Canon portrait lens", mustWords: [["85mm"], ["canon"]] });
    const searchId = await searchOf(anyBrand);
    const { ebay, poll, job, log } = setupSearch();
    ebay.searchPages(
      searchPage([
        lens({ legacyItemId: "955500000301", title: "Canon EF 85mm 1.8 USM" }),
        lens({ legacyItemId: "955500000302", title: "Sigma 85mm 1.4 Art" }),
      ]),
    );

    await poll({ searchId }, job());

    expect(await searchOf(canon)).toBe(searchId);
    expect(await rows("SELECT segment FROM app.candidate ORDER BY segment")).toEqual(
      [{ segment: anyBrand.key }, { segment: canon.key }].sort((x, y) => (x.segment < y.segment ? -1 : 1)),
    );
    const itemKey = createItemKey(ITEM_KEY_SECRET);
    expect(await rows("SELECT segment FROM app.seen_item WHERE item_key = $1", [itemKey("955500000301").itemKey])).toEqual([
      { segment: canon.key },
    ]);
    expect(log.events("poll_run")).toMatchObject([{ search: searchId, ambiguous: 1, candidates: 2 }]);
  });

  it("in market mode takes the limit from the group's newest ok value before the first sighting, and stores which value", async () => {
    const product = await createProduct({ priceMode: "below_market", belowMarketPct: 15 });
    const searchId = await searchOf(product);
    // Used: EUR 320 typical asking price, so the limit is EUR 272 rounded down to EUR 270, under the EUR 300 cap.
    const value = await db.admin.query<{ id: string }>(
      `INSERT INTO app.market_value (product_id, condition_group, match_version, computed_at, method_version, status, capped,
         n, neff, value_cents)
       VALUES ($1, 'used', $2, $3, 'mv-1', 'ok', false, 30, 22, 32000) RETURNING id`,
      [product.id, product.matchVersion, new Date(NOW.getTime() - 24 * HOUR_MS)],
    );
    // A value computed after the first sighting does not count for it.
    await db.admin.query(
      `INSERT INTO app.market_value (product_id, condition_group, match_version, computed_at, method_version, status, capped,
         n, neff, value_cents)
       VALUES ($1, 'used', $2, $3, 'mv-1', 'ok', false, 30, 22, 20000)`,
      [product.id, product.matchVersion, new Date(NOW.getTime() + 60_000)],
    );
    const { ebay, poll, job } = setupSearch();
    ebay.searchPages(
      searchPage([
        lens({ legacyItemId: "955500000401", price: "250.00", shipping: "10.00" }),
        lens({ legacyItemId: "955500000402", price: "280.00", shipping: "10.00" }),
      ]),
    );

    await poll({ searchId }, job());

    expect(await rows("SELECT landed_cents, condition_group, limit_cents, price_mode, market_value_id FROM app.candidate")).toEqual([
      { landed_cents: 26000, condition_group: "used", limit_cents: 27000, price_mode: "below_market", market_value_id: value.rows[0]?.id },
    ]);
    expect(await rows("SELECT outcome FROM app.seen_item ORDER BY outcome")).toEqual([{ outcome: "above_max" }, { outcome: "candidate" }]);
  });

  it("in market mode uses the value of the new match version for a listing first seen before a rules change, not the cap", async () => {
    const product = await createProduct({ priceMode: "below_market", belowMarketPct: 15 });
    const searchId = await searchOf(product);
    const insertValue = (matchVersion: number, at: Date) =>
      db.admin.query(
        `INSERT INTO app.market_value (product_id, condition_group, match_version, computed_at, method_version, status, capped,
           n, neff, value_cents)
         VALUES ($1, 'used', $2, $3, 'mv-1', 'ok', false, 30, 22, 32000)`,
        [product.id, matchVersion, at],
      );
    // EUR 320 typical asking price: limit EUR 270 under the EUR 300 cap.
    await insertValue(product.matchVersion, new Date(NOW.getTime() - 24 * HOUR_MS));
    const { ebay, clock, poll, job } = setupSearch();
    const item = lens({ legacyItemId: "955500000451", price: "280.00", shipping: "10.00" });
    ebay.searchPages(searchPage([item]), searchPage([item]));
    await poll({ searchId }, job());
    // One exclude word more: a new match version, and its first value lands after the first sighting.
    const changed = await saveProductWithPlan(
      db.admin,
      { kind: "update", id: product.id, version: product.version, fields: { ...product.rules, excludeWords: ["defekt"] } },
      { at: new Date(NOW.getTime() + 60_000), actor: "system:cli", userId: null, env: SETTINGS_ENV },
    );
    if (!changed.ok) throw new Error("save refused");
    await insertValue(changed.product.matchVersion, new Date(NOW.getTime() + 2 * 60_000));
    clock.advance(5 * 60_000);
    await poll({ searchId }, job());

    expect(changed.product.matchVersion, "match version after the edit").toBe(product.matchVersion + 1);
    expect(await rows("SELECT outcome FROM app.seen_item")).toEqual([{ outcome: "above_max" }]);
    expect(await rows("SELECT id FROM app.candidate")).toEqual([]);
  });

  it("records a paused product's listing as product_paused, and makes it a candidate when seen again after the resume", async () => {
    const portrait = await createProduct();
    const telephoto = await createProduct({ name: "Telephoto lens", searchWords: ["200mm"], mustWords: [["200mm"]] });
    const update = async (product: StoredProduct, status: string) => {
      const result = await saveProductWithPlan(
        db.admin,
        { kind: "update", id: product.id, version: product.version, fields: { ...product.rules, status } },
        { at: new Date(NOW.getTime() - HOUR_MS), actor: "system:cli", userId: null, env: SETTINGS_ENV },
      );
      if (!result.ok) throw new Error("save refused");
      return result.product;
    };
    const paused = await update(telephoto, "paused");
    const searchId = await searchOf(portrait);
    const { ebay, clock, poll, job } = setupSearch();
    const tele = lens({ legacyItemId: "955500000501", title: "Canon EF 200mm 2.8 L" });
    ebay.searchPages(searchPage([tele, lens({ legacyItemId: "955500000502" })]), searchPage([tele]));

    await poll({ searchId }, job());
    const whilePaused = await rows("SELECT segment, outcome FROM app.seen_item ORDER BY segment");
    await update(paused, "active");
    clock.advance(5 * 60_000);
    await poll({ searchId }, job());

    expect(whilePaused).toEqual(
      [
        { segment: portrait.key, outcome: "candidate" },
        { segment: telephoto.key, outcome: "product_paused" },
      ].sort((x, y) => (x.segment < y.segment ? -1 : 1)),
    );
    expect(await rows("SELECT segment FROM app.candidate WHERE segment = $1", [telephoto.key])).toEqual([{ segment: telephoto.key }]);
  });
});

describe("poll handler, baseline by listing age (spec 5.5)", () => {
  it("records listings created before the product's watch_from as baseline with price samples, and never makes them candidates", async () => {
    const product = await createProduct();
    const searchId = await searchOf(product);
    const { ebay, clock, poll, job } = setupSearch();
    // watch_from is NOW - 2 h; these were listed 3 hours ago.
    const created = new Date(NOW.getTime() - 3 * HOUR_MS).toISOString();
    const listed = { legacyItemId: "955500000101", itemCreationDate: created };
    ebay.searchPages(
      searchPage([
        lens({ ...listed, price: "250.00" }),
        lens({ itemCreationDate: created, price: "400.00" }),
        lens({ itemCreationDate: created, title: "Gegenlichtblende für 85mm Objektiv", price: "30.00" }),
      ]),
      searchPage([lens({ ...listed, price: "240.00" })]),
    );

    await poll({ searchId }, job());
    clock.advance(5 * 60_000);
    await poll({ searchId }, job());

    // Rejections by the product's own rules are baseline too, so no later price drop alerts.
    expect(await rows("SELECT segment, outcome FROM app.seen_item ORDER BY outcome")).toEqual([
      { segment: product.key, outcome: "baseline" },
      { segment: product.key, outcome: "baseline" },
      { segment: product.key, outcome: "baseline" },
    ]);
    expect(await rows("SELECT segment, feed_id, price_cents FROM app.price_sample ORDER BY price_cents")).toEqual([
      { segment: product.key, feed_id: searchId, price_cents: 25000 },
      { segment: product.key, feed_id: searchId, price_cents: 40000 },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM app.candidate")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM ebay_live.listing")).toEqual([{ n: 0 }]);
    expect(await jobs(db, "enrich")).toEqual([]);
  });

  it("finishes with the rows it read when the search words change mid-poll; later polls treat older listings as baseline", async () => {
    const product = await createProduct();
    const searchId = await searchOf(product);
    const { ebay, clock, poll, job } = setupSearch();
    const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
    const a = { legacyItemId: "955500000201", itemCreationDate: minutesAgo(60) };
    let saved = false;
    // The save lands after the poll read the products and before it commits its sightings.
    ebay.beforeSearch(async () => {
      if (saved) return;
      saved = true;
      const result = await saveProductWithPlan(
        db.admin,
        { kind: "update", id: product.id, version: product.version, fields: { ...product.rules, searchWords: ["85mm", "portrait"] } },
        { at: NOW, actor: "system:cli", userId: null, env: SETTINGS_ENV },
      );
      if (!result.ok) throw new Error("save refused");
    });
    ebay.searchPages(
      searchPage([
        lens({ ...a, price: "400.00" }),
        lens({ legacyItemId: "955500000202", itemCreationDate: minutesAgo(30) }),
      ]),
      searchPage([
        lens({ ...a, price: "250.00" }),
        lens({ legacyItemId: "955500000203", itemCreationDate: minutesAgo(10) }),
        lens({ legacyItemId: "955500000204", itemCreationDate: new Date(NOW.getTime() + 60_000).toISOString() }),
      ]),
    );

    await poll({ searchId }, job());
    clock.advance(5 * 60_000);
    await poll({ searchId }, job());

    const itemKey = createItemKey(ITEM_KEY_SECRET);
    const outcomes = await rows<{ item_key: string; outcome: string }>("SELECT item_key, outcome FROM app.seen_item");
    const byItem = Object.fromEntries(outcomes.map((row) => [row.item_key, row.outcome]));
    expect(["955500000201", "955500000202", "955500000203", "955500000204"].map((id) => byItem[itemKey(id).itemKey])).toEqual([
      "baseline",
      "candidate",
      "baseline",
      "candidate",
    ]);
    expect(await rows("SELECT watch_from FROM app.product")).toEqual([{ watch_from: NOW }]);
    expect(ebay.searches().map((url) => url.searchParams.get("q"))).toEqual(["85mm", "(85mm,portrait)"]);
  });
});

describe("poll handler, candidates (candidate once, caps)", () => {
  it("leaves no job and no candidate rows when the transaction fails after the enqueue", async () => {
    const searchId = await searchOf(await createProduct());
    const crashing: Pick<JobQueue, "send"> = {
      async send(name, payload, options) {
        await queue.send(name, payload, options);
        throw new Error("crash before commit");
      },
    };
    const { ebay, poll, job } = setupSearch({ queue: crashing });
    ebay.searchPages(searchPage([lens()]));

    await expect(poll({ searchId }, job())).rejects.toThrow("crash before commit");

    expect(await jobs(db, "enrich")).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM app.candidate")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM ebay_live.listing")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM ebay_live.listing_content")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.seen_item WHERE candidate_at IS NOT NULL")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT status, error_kind FROM app.poll_run")).toEqual([{ status: "error", error_kind: "db" }]);
  });

  it("makes one candidate of a listing that two searches see at the same time", async () => {
    const inLenses = await searchOf(await createProduct());
    const inCameras = await searchOf(await createProduct({ name: "Lens listed with cameras", categoryId: "31388" }));
    const same = { legacyItemId: "955500000601" };
    const first = setupSearch();
    const second = setupSearch();
    first.ebay.searchPages(searchPage([lens(same)]));
    second.ebay.searchPages(searchPage([lens({ ...same, categoryId: "31388" })]));

    await Promise.all([first.poll({ searchId: inLenses }, first.job()), second.poll({ searchId: inCameras }, second.job())]);

    expect(inLenses).not.toBe(inCameras);
    expect(await rows("SELECT count(*)::int AS n FROM app.candidate")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT count(*)::int AS n FROM ebay_live.listing")).toEqual([{ n: 1 }]);
    expect(await jobs(db, "enrich")).toHaveLength(1);
    expect(await rows("SELECT sum(candidates)::int AS n FROM app.poll_run")).toEqual([{ n: 1 }]);
  });

  it("makes the product's 10th candidate of a Berlin day and records the 11th as over_cap", async () => {
    // Saved a day earlier, so listings of the last hours are after watch_from.
    const product = await createProduct({}, new Date(NOW.getTime() - 24 * HOUR_MS));
    const searchId = await searchOf(product);
    // 9 candidates since Berlin midnight (22:00 UTC the day before), one just before it.
    await db.admin.query(
      `INSERT INTO app.candidate (item_key, listing_id, feed_id, segment, source, price_cents, shipping_known, rule_version, created_at)
       SELECT lpad(to_hex(n), 64, '0'), gen_random_uuid(), $1, $2, 'poll', 25000, true, 1,
              CASE WHEN n = 0 THEN '2026-10-20T21:59:59Z'::timestamptz ELSE '2026-10-20T22:00:00Z'::timestamptz END
         FROM generate_series(0, 9) AS n`,
      [searchId, product.key],
    );
    const { ebay, poll, job } = setupSearch();
    ebay.searchPages(searchPage([lens({ legacyItemId: "955500000710" }), lens({ legacyItemId: "955500000711", price: "260.00" })]));

    await poll({ searchId }, job());

    const itemKey = createItemKey(ITEM_KEY_SECRET);
    const outcomes = await rows<{ item_key: string; outcome: string }>("SELECT item_key, outcome FROM app.seen_item");
    expect(Object.fromEntries(outcomes.map((r) => [r.item_key, r.outcome]))).toEqual({
      [itemKey("955500000710").itemKey]: "candidate",
      [itemKey("955500000711").itemKey]: "over_cap",
    });
    expect(await rows("SELECT candidates FROM app.poll_run")).toEqual([{ candidates: 1 }]);
  });

  it("records an in-band listing first seen 25 hours after it was listed as too_old, never a candidate", async () => {
    const searchId = await searchOf(await createProduct({}, new Date(NOW.getTime() - 48 * HOUR_MS)));
    const { ebay, clock, poll, job } = setupSearch();
    const old = lens({ itemCreationDate: new Date(NOW.getTime() - 25 * HOUR_MS).toISOString() });
    ebay.searchPages(searchPage([old]), searchPage([old]));

    await poll({ searchId }, job());
    clock.advance(5 * 60_000);
    await poll({ searchId }, job());

    expect(await rows("SELECT outcome FROM app.seen_item")).toEqual([{ outcome: "too_old" }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.candidate")).toEqual([{ n: 0 }]);
  });

  it("stores the first sighting as the listing's first_seen_at, the time enrich and screen resolve the limit at (spec 6.4)", async () => {
    const searchId = await searchOf(await createProduct());
    const { ebay, clock, poll, job } = setupSearch();
    const item = { legacyItemId: "955500000811" };
    ebay.searchPages(searchPage([lens({ ...item, price: "350.00" })]), searchPage([lens({ ...item, price: "280.00" })]));

    await poll({ searchId }, job());
    clock.advance(5 * 60_000);
    await poll({ searchId }, job());

    expect(await rows("SELECT first_seen_at FROM ebay_live.listing")).toEqual([{ first_seen_at: NOW }]);
  });

  it("makes a tracked listing a candidate once its price drops into the band, only once, and confirms it after", async () => {
    const searchId = await searchOf(await createProduct());
    const { ebay, clock, poll, job } = setupSearch();
    const item = { legacyItemId: "955500000801" };
    ebay.searchPages(
      searchPage([lens({ ...item, price: "350.00" })]),
      searchPage([lens({ ...item, price: "280.00" })]),
      searchPage([lens({ ...item, price: "270.00" })]),
    );

    await poll({ searchId }, job());
    const afterFirst = await rows("SELECT outcome FROM app.seen_item");
    clock.advance(5 * 60_000);
    await poll({ searchId }, job());
    clock.advance(5 * 60_000);
    await poll({ searchId }, job());

    expect(afterFirst).toEqual([{ outcome: "above_max" }]);
    expect(await rows("SELECT price_cents FROM app.candidate")).toEqual([{ price_cents: 28000 }]);
    expect(await jobs(db, "enrich")).toHaveLength(1);
    expect(await rows("SELECT last_confirmed_at FROM ebay_live.listing")).toEqual([
      { last_confirmed_at: new Date(NOW.getTime() + 10 * 60_000) },
    ]);
  });
});

describe("poll handler, request and samples", () => {
  it("searches the search's category newest first with its conditions, price filter and the German postal code", async () => {
    const searchId = await searchOf(await createProduct());
    const { ebay, poll, job } = setupSearch();

    await poll({ searchId }, job());

    const [url] = ebay.searches();
    // The search's floor is 40 % of the EUR 300 max, its read ceiling 2 x the max rounded up to EUR 100.
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      q: "85mm",
      category_ids: LENS_CATEGORY,
      filter:
        "buyingOptions:{FIXED_PRICE|BEST_OFFER},conditionIds:{3000},deliveryCountry:DE,itemLocationCountry:DE,price:[120..600],priceCurrency:EUR",
      sort: "newlyListed",
      limit: "200",
      offset: "0",
    });
    const search = ebay.requests.find((r) => r.kind === "search");
    expect(search?.headers["x-ebay-c-enduserctx"]).toBe("contextualLocation=country%3DDE%2Czip%3D80331");
    expect(search?.headers["x-ebay-c-marketplace-id"]).toBe("EBAY_DE");
  });

  it("samples the titles of first sightings with the product and reason code, and no later sighting again", async () => {
    const product = await createProduct();
    const searchId = await searchOf(product);
    const { ebay, clock, poll, job, log } = setupSearch();
    const page = searchPage([
      lens({ legacyItemId: "955500000901", title: "Canon EF 85mm 1.8 USM" }),
      lens({ legacyItemId: "955500000902", title: "Suche 85mm Objektiv", price: "200.00" }),
      lens({ legacyItemId: "955500000903", title: "Canon EF 85mm 1.4", currency: "USD" }),
    ]);
    ebay.searchPages(page, page);

    await poll({ searchId }, job());
    clock.advance(5 * 60_000);
    await poll({ searchId }, job());

    expect(await rows("SELECT feed_id, title, segment, landed_cents, outcome, reason FROM ebay_live.classifier_sample ORDER BY title")).toEqual([
      { feed_id: searchId, title: "Canon EF 85mm 1.4", segment: null, landed_cents: null, outcome: "rejected", reason: "not_eur" },
      { feed_id: searchId, title: "Canon EF 85mm 1.8 USM", segment: product.key, landed_cents: 26000, outcome: "candidate", reason: null },
      { feed_id: searchId, title: "Suche 85mm Objektiv", segment: null, landed_cents: 21000, outcome: "rejected", reason: "wanted_ad" },
    ]);
    expect(await rows("SELECT outcome FROM app.seen_item ORDER BY outcome")).toEqual([
      { outcome: "candidate" },
      { outcome: "not_eur" },
      { outcome: "wanted_ad" },
    ]);
    // Titles go to ebay_live only, never to the log (ADR 0024).
    expect(log.text()).not.toContain("USM");
  });
});

// A listing of the category the product's rules reject: unseen on each call.
const hood = () => lens({ title: "Gegenlichtblende für 85mm Objektiv", price: "130.00" });

describe("poll handler, pages (spec 5.2 overflow)", () => {
  it("reads page 2 when page 1 was all unseen, and counts a malformed item without processing it", async () => {
    const searchId = await searchOf(await createProduct());
    const { ebay, poll, job } = setupSearch();
    const page1 = Array.from({ length: 200 }, hood);
    // No itemId: the schema refuses it.
    const page2 = [...Array.from({ length: 49 }, hood), { title: "Canon EF 85mm", price: { value: "250.00", currency: "EUR" } }];
    ebay.searchPages(searchPage(page1, { next: true }), searchPage(page2, { offset: 200 }));

    await poll({ searchId }, job());

    expect(ebay.searches().map((url) => url.searchParams.get("offset"))).toEqual(["0", "200"]);
    expect(await rows("SELECT pages, items, malformed, new_items, cap_reached, calls FROM app.poll_run")).toEqual([
      { pages: 2, items: 249, malformed: 1, new_items: 249, cap_reached: false, calls: 2 },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM app.seen_item WHERE outcome = 'accessory'")).toEqual([{ n: 249 }]);
  });

  it("stops at page 1 with cap_reached once the search used its 10 overflow pages this Berlin day", async () => {
    const searchId = await searchOf(await createProduct());
    // Earlier polls of this search today with 2 + 8 overflow pages; one of another search.
    await db.admin.query(
      `INSERT INTO app.poll_run (feed_id, kind, started_at, finished_at, status, pages)
       VALUES ($1, 'poll', $2, $2, 'ok', 3), ($1, 'poll', $2, $2, 'ok', 9), ('s999', 'poll', $2, $2, 'ok', 3)`,
      [searchId, new Date("2026-10-20T22:30:00.000Z")],
    );
    const { ebay, poll, job } = setupSearch();
    ebay.searchPages(searchPage([hood()], { next: true }));

    await poll({ searchId }, job());

    expect(ebay.searches()).toHaveLength(1);
    expect(await rows("SELECT pages, cap_reached FROM app.poll_run WHERE pages = 1")).toEqual([{ pages: 1, cap_reached: true }]);
  });

  it("reads at most 3 pages and sets cap_reached when page 3 is still all unseen", async () => {
    const searchId = await searchOf(await createProduct());
    const { ebay, poll, job } = setupSearch();
    const page = (offset: number) => searchPage([hood()], { next: true, offset });
    ebay.searchPages(page(0), page(200), page(400), page(600));

    await poll({ searchId }, job());

    expect(ebay.searches()).toHaveLength(3);
    expect(await rows("SELECT pages, cap_reached FROM app.poll_run")).toEqual([{ pages: 3, cap_reached: true }]);
  });

  it("reads no page 2 when page 1 holds a listing seen before", async () => {
    const searchId = await searchOf(await createProduct());
    const { ebay, clock, poll, job } = setupSearch();
    const known = hood();
    ebay.searchPages(searchPage([known]), searchPage([known, hood()], { next: true }));

    await poll({ searchId }, job());
    clock.advance(5 * 60_000);
    await poll({ searchId }, job());

    expect(ebay.searches()).toHaveLength(2);
    expect(await rows("SELECT pages, new_items, cap_reached FROM app.poll_run ORDER BY items")).toEqual([
      { pages: 1, new_items: 1, cap_reached: false },
      { pages: 1, new_items: 1, cap_reached: false },
    ]);
  });

  it("reserves no further page once the deadline has passed, and keeps what page 1 wrote", async () => {
    const searchId = await searchOf(await createProduct());
    const { ebay, reserve, poll, job } = setupSearch();
    const deadline = new AbortController();
    ebay.beforeSearch(() => deadline.abort());
    ebay.searchPages(searchPage([hood()], { next: true }));

    await poll({ searchId }, job(deadline.signal));

    expect(reserve.reservations).toHaveLength(1);
    expect(await rows("SELECT status, error_kind, pages, items FROM app.poll_run")).toEqual([
      { status: "error", error_kind: "deadline", pages: 1, items: 1 },
    ]);
  });
});

describe("poll handler, run rows", () => {
  it("has the running row committed before the first request", async () => {
    const searchId = await searchOf(await createProduct());
    const { ebay, poll, job } = setupSearch();
    const atRequest: unknown[] = [];
    ebay.beforeSearch(async () => {
      atRequest.push(...(await rows("SELECT feed_id, kind, status, finished_at FROM app.poll_run")));
    });

    await poll({ searchId }, job());

    expect(atRequest).toEqual([{ feed_id: searchId, kind: "poll", status: "running", finished_at: null }]);
  });

  it("ends a hanging request at the deadline and finishes the row as error with error_kind deadline", async () => {
    const searchId = await searchOf(await createProduct());
    const { ebay, poll, job, log } = setupSearch();
    ebay.respondToSearch((_url, signal) => hang(signal));

    await poll({ searchId }, job(AbortSignal.timeout(300)));

    expect(await rows("SELECT status, error_kind, calls, finished_at IS NOT NULL AS finished FROM app.poll_run")).toEqual([
      { status: "error", error_kind: "deadline", calls: 1, finished: true },
    ]);
    expect(log.events("poll_run")).toMatchObject([{ search: searchId, kind: "poll", status: "error", error_kind: "deadline" }]);
  });

  it("records quota_refused and sends no search when the reservation is refused", async () => {
    const searchId = await searchOf(await createProduct());
    const { ebay, reserve, poll, job, log } = setupSearch();
    reserve.refuse();

    await poll({ searchId }, job());

    expect(ebay.searches()).toEqual([]);
    expect(reserve.reservations).toEqual([{ resource: "buy.browse", callClass: "standard", purpose: "poll", minLeft: 1500 }]);
    expect(await rows("SELECT status, error_kind, calls FROM app.poll_run")).toEqual([
      { status: "quota_refused", error_kind: null, calls: 0 },
    ]);
    expect(log.events("quota_refused")).toMatchObject([{ search: searchId, kind: "poll" }]);
  });

  it.each([
    ["was retired when its only product was archived", "archived"],
    ["polls only a paused product", "paused"],
  ])("records paused and sends nothing for a search that %s after the job was queued", async (_name, status) => {
    const product = await createProduct();
    const searchId = await searchOf(product);
    const result = await saveProductWithPlan(
      db.admin,
      { kind: "update", id: product.id, version: product.version, fields: { ...product.rules, status } },
      { at: NOW, actor: "system:cli", userId: null, env: SETTINGS_ENV },
    );
    if (!result.ok) throw new Error("save refused");
    const { ebay, reserve, poll, job } = setupSearch();

    await poll({ searchId }, job());

    expect(ebay.requests).toEqual([]);
    expect(reserve.reservations).toEqual([]);
    expect(await rows("SELECT feed_id, status, calls FROM app.poll_run")).toEqual([{ feed_id: searchId, status: "paused", calls: 0 }]);
  });

  it("records paused and sends nothing for a search id no row has", async () => {
    const { ebay, poll, job } = setupSearch();

    await poll({ searchId: "s404" }, job());

    expect(ebay.requests).toEqual([]);
    expect(await rows("SELECT feed_id, kind, status FROM app.poll_run")).toEqual([{ feed_id: "s404", kind: "poll", status: "paused" }]);
  });
});
