import type { MarketValueResult } from "@ebay-sniper/domain";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  MARKET_EXTRA_SNAPSHOTS_PER_DAY,
  MARKET_PURGE_STEPS,
  loadMarketPool,
  newestMarketValues,
  newestOkMarketValues,
  storeMarketValues,
  takeExtraSnapshotSlot,
  upsertMarketListings,
  wrongProductItemKeys,
  type MarketSighting,
} from "./market-store.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// Spec 2.4, 5.4 and 6. The worker writes and purges the market tables, web reads them, so every
// store call runs as the role that makes it in production.

let database: TestDatabase;
let worker: pg.Pool;
let web: pg.Pool;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
  worker = new pg.Pool({ connectionString: database.url, max: 30, options: "-c role=worker" });
  web = new pg.Pool({ connectionString: database.url, max: 2, options: "-c role=web" });
});

afterAll(async () => {
  await worker.end();
  await web.end();
  await database.drop();
});

const T0 = new Date("2026-10-22T08:00:00.000Z");
const hours = (n: number): Date => new Date(T0.getTime() + n * 3_600_000);
const days = (n: number): Date => hours(n * 24);
const itemKey = (n: number): string => n.toString(16).padStart(64, "0");

let products = 0;
async function newProduct(): Promise<{ id: string; key: string }> {
  products += 1;
  const key = `p_store${products}`;
  const result = await database.pool.query<{ id: string }>(
    `INSERT INTO app.product (key, name, description, category_id, condition_ids, search_words, must_words, price_mode,
       max_cents, sweep_minute, buyer_profile)
     VALUES ($1, 'n', 'd', '27386', '{3000}', '{w}', '[["w"]]', 'fixed', 100000, 1, 'company') RETURNING id`,
    [key],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("no product inserted");
  return { id, key };
}

const sighting = (n: number, seenAt: Date, change: Partial<MarketSighting> = {}): MarketSighting => ({
  source: "ebay",
  itemKey: itemKey(n),
  conditionGroup: "used",
  matchVersion: 1,
  landedCents: 50_000,
  unitTotal: null,
  originAt: days(-3),
  seenAt,
  bestOffer: false,
  excludedReason: null,
  ...change,
});

type ListingRow = {
  item_key: string;
  match_version: number;
  landed_cents: number;
  best_offer: boolean;
  first_seen_at: Date;
  last_seen_at: Date;
};

async function listings(productId: string): Promise<ListingRow[]> {
  const result = await database.pool.query<ListingRow>(
    `SELECT item_key, match_version, landed_cents, best_offer, first_seen_at, last_seen_at
       FROM app.market_listing WHERE product_id = $1 ORDER BY item_key`,
    [productId],
  );
  return result.rows;
}

describe("upsertMarketListings", () => {
  it("keeps one row per listing with the latest price and the first sighting", async () => {
    const product = await newProduct();
    await upsertMarketListings(worker, product.id, [sighting(1, hours(0)), sighting(2, hours(0), { landedCents: 40_000 })]);
    await upsertMarketListings(worker, product.id, [sighting(1, hours(5), { landedCents: 45_000, bestOffer: true })]);
    await upsertMarketListings(worker, product.id, []);

    expect(await listings(product.id)).toEqual([
      { item_key: itemKey(1), match_version: 1, landed_cents: 45_000, best_offer: true, first_seen_at: hours(0), last_seen_at: hours(5) },
      { item_key: itemKey(2), match_version: 1, landed_cents: 40_000, best_offer: false, first_seen_at: hours(0), last_seen_at: hours(0) },
    ]);
  });

  it("keeps the newer price when an older sighting arrives late, but moves the first sighting back", async () => {
    const product = await newProduct();
    await upsertMarketListings(worker, product.id, [sighting(1, hours(5), { landedCents: 45_000 })]);
    await upsertMarketListings(worker, product.id, [sighting(1, hours(2), { landedCents: 60_000 })]);

    expect(await listings(product.id)).toEqual([
      { item_key: itemKey(1), match_version: 1, landed_cents: 45_000, best_offer: false, first_seen_at: hours(2), last_seen_at: hours(5) },
    ]);
  });

  it("takes the latest of the same listing twice in one batch", async () => {
    const product = await newProduct();
    await upsertMarketListings(worker, product.id, [
      sighting(1, hours(3), { landedCents: 30_000 }),
      sighting(1, hours(1), { landedCents: 70_000 }),
    ]);

    expect(await listings(product.id)).toEqual([
      { item_key: itemKey(1), match_version: 1, landed_cents: 30_000, best_offer: false, first_seen_at: hours(1), last_seen_at: hours(3) },
    ]);
  });

  it("never lets a sighting of an older match version replace a newer one", async () => {
    const product = await newProduct();
    await upsertMarketListings(worker, product.id, [sighting(1, hours(0)), sighting(2, hours(0))]);
    await upsertMarketListings(worker, product.id, [sighting(1, hours(1), { matchVersion: 2, landedCents: 55_000 })]);
    await upsertMarketListings(worker, product.id, [sighting(1, hours(2), { matchVersion: 1, landedCents: 99_000 })]);
    await upsertMarketListings(worker, product.id, [sighting(2, hours(-1), { matchVersion: 2, landedCents: 41_000 })]);

    expect(await listings(product.id)).toEqual([
      { item_key: itemKey(1), match_version: 2, landed_cents: 55_000, best_offer: false, first_seen_at: hours(0), last_seen_at: hours(1) },
      // A newer match version wins even when its sighting is older.
      { item_key: itemKey(2), match_version: 2, landed_cents: 41_000, best_offer: false, first_seen_at: hours(-1), last_seen_at: hours(0) },
    ]);
  });

  it("keeps the same item key of two sources and two products apart", async () => {
    const one = await newProduct();
    const two = await newProduct();
    await upsertMarketListings(worker, one.id, [sighting(1, hours(0)), sighting(1, hours(0), { source: "kleinanzeigen", landedCents: 1 })]);
    await upsertMarketListings(worker, two.id, [sighting(1, hours(0), { landedCents: 2 })]);

    const rows = await database.pool.query<{ product_id: string; source: string; landed_cents: number }>(
      "SELECT product_id, source, landed_cents FROM app.market_listing WHERE product_id = ANY($1) ORDER BY landed_cents",
      [[one.id, two.id]],
    );
    expect(rows.rows).toEqual([
      { product_id: one.id, source: "kleinanzeigen", landed_cents: 1 },
      { product_id: two.id, source: "ebay", landed_cents: 2 },
      { product_id: one.id, source: "ebay", landed_cents: 50_000 },
    ]);
  });
});

describe("loadMarketPool", () => {
  it("reads the product's listings seen in the 30 days before the run, as computeMarketValue takes them", async () => {
    const product = await newProduct();
    const other = await newProduct();
    await upsertMarketListings(worker, product.id, [
      sighting(1, days(-30), { originAt: null }),
      sighting(2, days(-31)),
      sighting(3, days(-1), { conditionGroup: null, excludedReason: "unknown_shipping", unitTotal: 32, bestOffer: true }),
    ]);
    await upsertMarketListings(worker, other.id, [sighting(4, days(-1))]);

    const pool = await loadMarketPool(web, product.id, T0);
    expect(pool.sort((a, b) => a.itemKey.localeCompare(b.itemKey))).toEqual([
      {
        itemKey: itemKey(1),
        source: "ebay",
        conditionGroup: "used",
        matchVersion: 1,
        landedCents: 50_000,
        unitTotal: null,
        originAt: null,
        firstSeenAt: days(-30),
        lastSeenAt: days(-30),
        bestOffer: false,
        excludedReason: null,
      },
      {
        itemKey: itemKey(3),
        source: "ebay",
        conditionGroup: null,
        matchVersion: 1,
        landedCents: 50_000,
        unitTotal: 32,
        originAt: days(-3),
        firstSeenAt: days(-1),
        lastSeenAt: days(-1),
        bestOffer: true,
        excludedReason: "unknown_shipping",
      },
    ]);
  });
});

describe("wrongProductItemKeys", () => {
  it("returns the item keys of this product's candidates that Claude called wrong_product", async () => {
    const product = await newProduct();
    const other = await newProduct();
    const candidate = (n: number, segment: string, decision: string) =>
      database.pool.query(
        `INSERT INTO app.candidate (item_key, listing_id, feed_id, segment, source, shipping_known, rule_version, decision)
         VALUES ($1, gen_random_uuid(), 's1', $2, 'poll', true, 1, $3)`,
        [itemKey(n), segment, decision],
      );
    await candidate(101, product.key, "wrong_product");
    await candidate(102, product.key, "alerted");
    await candidate(103, other.key, "wrong_product");
    await candidate(104, product.key, "wrong_product");

    expect(await wrongProductItemKeys(worker, product.id)).toEqual(new Set([itemKey(101), itemKey(104)]));
  });
});

const value = (change: Partial<MarketValueResult> = {}): MarketValueResult => ({
  methodVersion: "mv-1",
  conditionGroup: "used",
  matchVersion: 1,
  computedAt: T0,
  status: "ok",
  capped: false,
  n: 23,
  neff: 18.25,
  mCents: 61_200,
  p25Cents: 56_000,
  p75Cents: 68_000,
  loCents: 58_000,
  hiCents: 64_000,
  halfWidth: 0.0588,
  bestOfferShare: 0.3,
  valueCents: 61_200,
  counts: { too_cheap: 3, outlier: 1 },
  ...change,
});

describe("storeMarketValues", () => {
  it("stores one row per condition group with every column of the result", async () => {
    const product = await newProduct();
    const none = value({
      conditionGroup: "new",
      status: "none",
      n: 0,
      neff: 0,
      mCents: null,
      p25Cents: null,
      p75Cents: null,
      loCents: null,
      hiCents: null,
      halfWidth: null,
      bestOfferShare: null,
      valueCents: null,
      counts: {},
    });
    const stored = await storeMarketValues(worker, product.id, [value({ capped: true }), none]);
    if (!stored.ok) throw new Error("not stored");
    expect(stored.values.map((v) => [v.conditionGroup, v.status, v.valueCents])).toEqual([
      ["used", "ok", 61_200],
      ["new", "none", null],
    ]);

    expect(await newestMarketValues(web, product.id, 1)).toEqual([
      { ...none, id: stored.values[1]?.id },
      { ...value({ capped: true }), id: stored.values[0]?.id },
    ]);
  });

  it("stores nothing when the product's match version changed during the snapshot", async () => {
    const product = await newProduct();
    await database.pool.query("UPDATE app.product SET match_version = 2 WHERE id = $1", [product.id]);

    expect(await storeMarketValues(worker, product.id, [value()])).toEqual({ ok: false, reason: "match_version_changed" });
    expect(await newestMarketValues(web, product.id, 1)).toEqual([]);
    expect(await storeMarketValues(worker, product.id, [])).toEqual({ ok: true, values: [] });
  });
});

describe("newestOkMarketValues", () => {
  it("picks per group the newest ok value of the match version computed before the time", async () => {
    const product = await newProduct();
    const other = await newProduct();
    await database.pool.query("UPDATE app.product SET match_version = 2 WHERE id = ANY($1)", [[product.id, other.id]]);
    const store = async (productId: string, change: Partial<MarketValueResult>) => {
      const stored = await storeMarketValues(worker, productId, [value({ matchVersion: 2, ...change })]);
      if (!stored.ok) throw new Error("not stored");
      return stored.values[0]?.id;
    };
    await store(product.id, { computedAt: hours(-30), valueCents: 1 });
    const used = await store(product.id, { computedAt: hours(-20), valueCents: 2 });
    await store(product.id, { computedAt: hours(-10), valueCents: 3, status: "rough" });
    // Computed at the listing's first sighting itself: not before it.
    await store(product.id, { computedAt: T0, valueCents: 4 });
    await store(product.id, { computedAt: hours(1), valueCents: 5 });
    const openBox = await store(product.id, { computedAt: hours(-40), valueCents: 6, conditionGroup: "open_box" });
    await store(product.id, { computedAt: hours(-2), valueCents: 7, conditionGroup: "new", status: "none" });
    await store(other.id, { computedAt: hours(-1), valueCents: 8 });
    // A value of the older match version, written before the product's last matching edit.
    await database.pool.query("UPDATE app.product SET match_version = 1 WHERE id = $1", [product.id]);
    await store(product.id, { computedAt: hours(-1), valueCents: 9, matchVersion: 1 });

    const values = await newestOkMarketValues(worker, product.id, 2, T0);
    expect(values).toEqual([
      { id: openBox, conditionGroup: "open_box", matchVersion: 2, computedAt: hours(-40), status: "ok", capped: false, valueCents: 6 },
      { id: used, conditionGroup: "used", matchVersion: 2, computedAt: hours(-20), status: "ok", capped: false, valueCents: 2 },
    ]);
    expect((await newestOkMarketValues(web, product.id, 2, hours(2))).map((v) => v.valueCents)).toEqual([6, 5]);
    expect((await newestOkMarketValues(web, product.id, 1, T0)).map((v) => v.valueCents)).toEqual([9]);
  });
});

describe("newestOkMarketValues after the purge", () => {
  it("skips a value whose price the purge removed, so the older one before it is still found", async () => {
    const product = await newProduct();
    const older = await storeMarketValues(worker, product.id, [value({ computedAt: hours(-30), valueCents: 1 })]);
    const purged = await storeMarketValues(worker, product.id, [value({ computedAt: hours(-20), valueCents: 2 })]);
    if (!older.ok || !purged.ok) throw new Error("not stored");
    await database.pool.query("UPDATE app.market_value SET value_cents = NULL, m_cents = NULL WHERE id = $1", [purged.values[0]?.id]);

    expect((await newestOkMarketValues(worker, product.id, 1, T0)).map((v) => v.id)).toEqual([older.values[0]?.id]);
  });
});

describe("takeExtraSnapshotSlot", () => {
  it("gives 20 slots a Berlin day and refuses the 21st", async () => {
    const at = new Date("2026-03-03T10:00:00.000Z");
    const taken: boolean[] = [];
    for (let n = 0; n < 21; n += 1) taken.push(await takeExtraSnapshotSlot(worker, at));

    expect(MARKET_EXTRA_SNAPSHOTS_PER_DAY).toBe(20);
    expect(taken.slice(0, 20).every(Boolean)).toBe(true);
    expect(taken[20]).toBe(false);
  });

  it("holds under parallel calls and starts again at Berlin midnight", async () => {
    // 22:00 UTC is midnight in Berlin in October (CEST).
    const lateEvening = new Date("2026-10-22T21:59:59.000Z");
    const results = await Promise.all(Array.from({ length: 30 }, () => takeExtraSnapshotSlot(worker, lateEvening)));
    expect(results.filter(Boolean)).toHaveLength(20);
    expect(await takeExtraSnapshotSlot(worker, new Date("2026-10-22T22:00:00.000Z"))).toBe(true);

    const rows = await database.pool.query<{ day: string; extra_snapshots: number }>(
      "SELECT day_berlin::text AS day, extra_snapshots FROM app.market_daily WHERE day_berlin >= '2026-10-22' ORDER BY day_berlin",
    );
    expect(rows.rows).toEqual([
      { day: "2026-10-22", extra_snapshots: 20 },
      { day: "2026-10-23", extra_snapshots: 1 },
    ]);
  });
});

// Runs each step the way runPurge does: $1 is the batch size, repeated until a batch is not full.
async function purge(now: Date, batchSize: number): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const step of MARKET_PURGE_STEPS) {
    let total = 0;
    for (;;) {
      const changed = (await worker.query(step.statement, [batchSize, ...step.params(now)])).rowCount ?? 0;
      total += changed;
      if (changed < batchSize) break;
    }
    counts[step.name] = total;
  }
  return counts;
}

describe("MARKET_PURGE_STEPS", () => {
  it("follows the lifetimes of spec 2.4, in batches, as role worker", async () => {
    const product = await newProduct();
    const q = (statement: string, params: unknown[] = []) => database.pool.query(statement, params);
    await q(
      "TRUNCATE app.market_listing, app.market_value, app.market_request, app.category_request, app.market_run, app.market_daily, ebay_live.market_preview",
    );

    // Listings: 30 days after the last sighting.
    await upsertMarketListings(worker, product.id, [
      sighting(1, days(-30)),
      sighting(2, days(-31)),
      sighting(3, days(-40)),
      sighting(4, hours(-24 * 30 + 1)),
    ]);
    // Values: prices NULL at 30 days, row kept 1 year.
    await storeMarketValues(worker, product.id, [
      value({ computedAt: days(-29) }),
      value({ computedAt: days(-30), conditionGroup: "new" }),
      value({ computedAt: days(-200), conditionGroup: "open_box" }),
      value({ computedAt: days(-366), conditionGroup: "refurbished" }),
    ]);
    // Requests: 7 days.
    await q(
      `INSERT INTO app.market_request (product_id, reason, requested_at, status, done_at)
       VALUES ($1, 'created', $2, 'done', $2), ($1, 'check_now', $3, 'refused', $3), ($1, 'rules_changed', $4, 'open', NULL)`,
      [product.id, days(-8), days(-7), days(-6)],
    );
    await q("INSERT INTO app.category_request (q, created_at, status, done_at) VALUES ('a', $1, 'done', $1), ('b', $2, 'open', NULL)", [
      days(-7),
      days(-6),
    ]);
    // Runs: 30 days.
    await q("INSERT INTO app.market_run (product_id, started_at, finished_at, status) VALUES ($1, $2, $2, 'ok'), ($1, $3, $3, 'ok')", [
      product.id,
      days(-30),
      days(-29),
    ]);
    // Snapshot titles: 6 hours.
    await q(
      `INSERT INTO ebay_live.market_preview (product_id, item_key, legacy_item_id, title, landed_cents, condition_group, outcome, seen_at)
       VALUES ($1, $2, '1', 't', 100, 'used', 'counted', $4), ($1, $3, '2', 't', 100, 'used', 'too_cheap', $5)`,
      [product.id, itemKey(1), itemKey(2), hours(-6), hours(-5)],
    );
    // The daily counter is kept.
    await takeExtraSnapshotSlot(worker, days(-400));

    expect(await purge(T0, 2)).toEqual({
      market_preview: 1,
      market_listing: 3,
      market_value: 1,
      market_value_prices: 2,
      market_request: 2,
      category_request: 1,
      market_run: 1,
    });
    expect(Object.values(await purge(T0, 2)).every((n) => n === 0)).toBe(true);

    expect((await listings(product.id)).map((row) => row.item_key)).toEqual([itemKey(4)]);
    const values = await q(
      `SELECT condition_group, m_cents, p25_cents, p75_cents, lo_cents, hi_cents, value_cents, n
         FROM app.market_value WHERE product_id = $1 ORDER BY computed_at`,
      [product.id],
    );
    const pricesGone = { m_cents: null, p25_cents: null, p75_cents: null, lo_cents: null, hi_cents: null, value_cents: null, n: 23 };
    expect(values.rows).toEqual([
      { condition_group: "open_box", ...pricesGone },
      { condition_group: "new", ...pricesGone },
      { condition_group: "used", m_cents: 61_200, p25_cents: 56_000, p75_cents: 68_000, lo_cents: 58_000, hi_cents: 64_000, value_cents: 61_200, n: 23 },
    ]);
    const left = await q(
      `SELECT (SELECT count(*)::int FROM app.market_request) AS requests, (SELECT count(*)::int FROM app.category_request) AS categories,
              (SELECT count(*)::int FROM app.market_run) AS runs, (SELECT count(*)::int FROM ebay_live.market_preview) AS previews,
              (SELECT count(*)::int FROM app.market_daily) AS days`,
    );
    expect(left.rows[0]).toEqual({ requests: 1, categories: 1, runs: 1, previews: 1, days: 1 });
  });
});
