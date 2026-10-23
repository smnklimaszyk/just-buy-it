import { reserveEbayCall, saveProductWithPlan, type StoredProduct } from "@ebay-sniper/db";
import type { EbayCallReservation } from "@ebay-sniper/ebay";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createItemKey } from "../item-key.js";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { createFakeEbay, createFakeReserve, itemSummary, searchPage, testSearch, type FakeEbay } from "../testing/ebay.js";
import { createTestLog } from "../testing/log.js";
import { createMarketSnapshotHandler, type MarketSnapshotDeps } from "./market-snapshot.js";
import { createPollHandler, type SearchDeps } from "./poll.js";

// 03:30 Berlin, inside the nightly window.
const NOW = new Date("2026-10-22T01:30:00.000Z");
const SETTINGS_ENV = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null };
const ITEM_KEY_SECRET = Buffer.alloc(32, 1).toString("base64");

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.admin.query(
    `TRUNCATE app.product, app.product_source, app.product_revision, app.search, app.search_product, app.setting,
              app.market_request, app.market_listing, app.market_value, app.market_run, app.market_daily,
              ebay_live.market_preview, app.audit_event, app.ebay_quota_window, app.api_usage_hourly CASCADE`,
  );
});

// Synthetic example product (ADR 0023): a used or new portrait lens.
const lensFields = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "Portrait lens",
  description: "An 85 mm portrait lens for a full-frame camera.",
  status: "active",
  categoryId: "3323",
  conditionIds: ["1000", "3000"],
  searchWords: ["85mm"],
  mustWords: [["85mm"]],
  priceMode: "fixed",
  maxCents: 30_000,
  buyerProfile: "private",
  ...overrides,
});

// A save from the form while the snapshot runs.
async function saveLens(product: StoredProduct, overrides: Record<string, unknown>): Promise<void> {
  const result = await saveProductWithPlan(
    db.admin,
    { kind: "update", id: product.id, version: product.version, fields: lensFields(overrides) },
    { at: NOW, actor: "system:cli", userId: null, env: SETTINGS_ENV },
  );
  if (!result.ok) throw new Error(`save refused: ${JSON.stringify(result)}`);
}

async function createLens(overrides: Record<string, unknown> = {}): Promise<StoredProduct> {
  const fields = {
    name: "Portrait lens",
    description: "An 85 mm portrait lens for a full-frame camera.",
    status: "active",
    categoryId: "3323",
    conditionIds: ["1000", "3000"],
    searchWords: ["85mm"],
    mustWords: [["85mm"]],
    priceMode: "fixed",
    maxCents: 30_000,
    buyerProfile: "private",
    ...overrides,
  };
  const result = await saveProductWithPlan(
    db.admin,
    { kind: "create", fields },
    { at: new Date(NOW.getTime() - 86_400_000), actor: "system:cli", userId: null, env: SETTINGS_ENV },
  );
  if (!result.ok) throw new Error(`save refused: ${JSON.stringify(result)}`);
  return result.product;
}

// A lens ask as a snapshot sees it.
const lens = (price: string, fields: Parameters<typeof itemSummary>[0] = {}) =>
  itemSummary({
    title: "Portrait lens 85mm f/1.8",
    price,
    categoryId: "3323",
    itemCreationDate: "2026-10-20T08:00:00.000Z",
    ...fields,
  });

function setup(overrides: Partial<MarketSnapshotDeps> = {}) {
  const clock = createTestClock(NOW);
  const ebay: FakeEbay = createFakeEbay();
  const reserve = createFakeReserve();
  const log = createTestLog();
  const deps: MarketSnapshotDeps = {
    pool: db.pool,
    clock,
    reserve: reserve.reserve,
    createSearch: testSearch(ebay, clock),
    itemKey: createItemKey(ITEM_KEY_SECRET),
    postalCode: "80331",
    log: log.log,
    ...overrides,
  };
  const run = (productId: string, signal = new AbortController().signal) =>
    createMarketSnapshotHandler(deps)({ productId }, { id: "snapshot-1", retryCount: 0, signal });
  return { ebay, reserve, log, run };
}

async function runs() {
  const result = await db.admin.query<{ status: string; calls: number; pages: number; total: number | null; error_kind: string | null }>(
    "SELECT status, calls, pages, total, error_kind FROM app.market_run ORDER BY started_at, id",
  );
  return result.rows;
}

async function values() {
  const result = await db.admin.query<{ condition_group: string; match_version: number; n: number; capped: boolean; m_cents: number | null }>(
    "SELECT condition_group, match_version, n, capped, m_cents FROM app.market_value ORDER BY condition_group",
  );
  return result.rows;
}

describe("market-snapshot handler, the nightly run (spec 6.3, 5.4)", () => {
  it("reserves with p_min_left 2,000 before the call and stores one value per watched condition group", async () => {
    const product = await createLens();
    // The create's request is served; this run is the nightly one.
    await db.admin.query("DELETE FROM app.market_request");
    const { ebay, reserve, run } = setup();
    ebay.searchPages(searchPage([lens("200.00"), lens("220.00"), lens("240.00"), lens("410.00", { conditionId: "1000" })]));
    const reservedBeforeEachCall: boolean[] = [];
    ebay.beforeSearch(() => {
      reservedBeforeEachCall.push(reserve.reservations.length === ebay.searches().length);
    });

    await run(product.id);

    expect(reserve.reservations).toEqual([
      { resource: "buy.browse", callClass: "standard", purpose: "market_nightly", minLeft: 2000 },
    ]);
    expect(reservedBeforeEachCall).toEqual([true]);
    const url = ebay.searches()[0];
    expect(url?.searchParams.get("q")).toBe("85mm");
    expect(url?.searchParams.get("category_ids")).toBe("3323");
    expect(url?.searchParams.get("sort")).toBe("newlyListed");
    expect(url?.searchParams.get("filter")).not.toContain("price:");
    expect(await values()).toEqual([
      { condition_group: "new", match_version: product.matchVersion, n: 1, capped: false, m_cents: 42_000 },
      { condition_group: "used", match_version: product.matchVersion, n: 3, capped: false, m_cents: 23_000 },
    ]);
    expect(await runs()).toEqual([{ status: "ok", calls: 1, pages: 1, total: 4, error_kind: null }]);
  });

  it("keeps the product's own matching asks, counts unknown shipping, and lists every title in the preview (spec 6.1, 6.6)", async () => {
    const product = await createLens({ conditionIds: ["3000"], excludeWords: ["adapter"] });
    await db.admin.query("DELETE FROM app.market_request");
    const { ebay, run } = setup();
    const counted = lens("200.00", { shipping: "5.00", legacyItemId: "900000000001", extra: { itemOriginDate: "2026-10-01T08:00:00.000Z" } });
    const bestOffer = lens("220.00", { legacyItemId: "900000000002", buyingOptions: ["FIXED_PRICE", "BEST_OFFER"] });
    const noShipping = lens("230.00", { shipping: null, legacyItemId: "900000000003" });
    const otherProduct = lens("40.00", { title: "Objektivdeckel 58mm", legacyItemId: "900000000004" });
    const excluded = lens("90.00", { title: "85mm Objektiv mit Adapter", legacyItemId: "900000000005" });
    const newOne = lens("300.00", { conditionId: "1000", legacyItemId: "900000000006" });
    ebay.searchPages(searchPage([counted, bestOffer, noShipping, otherProduct, excluded, newOne]));

    await run(product.id);

    const key = createItemKey(ITEM_KEY_SECRET);
    const listings = await db.admin.query(
      `SELECT item_key, condition_group, landed_cents, origin_at, best_offer, excluded_reason
         FROM app.market_listing ORDER BY landed_cents`,
    );
    expect(listings.rows).toEqual([
      {
        item_key: key("900000000001").itemKey,
        condition_group: "used",
        landed_cents: 20_500,
        origin_at: new Date("2026-10-01T08:00:00.000Z"),
        best_offer: false,
        excluded_reason: null,
      },
      {
        item_key: key("900000000002").itemKey,
        condition_group: "used",
        landed_cents: 23_000,
        origin_at: new Date("2026-10-20T08:00:00.000Z"),
        best_offer: true,
        excluded_reason: null,
      },
      {
        item_key: key("900000000003").itemKey,
        condition_group: "used",
        landed_cents: 23_000,
        origin_at: new Date("2026-10-20T08:00:00.000Z"),
        best_offer: false,
        excluded_reason: "unknown_shipping",
      },
    ]);
    const value = await db.admin.query("SELECT condition_group, n, counts FROM app.market_value");
    expect(value.rows).toEqual([{ condition_group: "used", n: 2, counts: { unknown_shipping: 1 } }]);
    const preview = await db.admin.query(
      "SELECT legacy_item_id, title, landed_cents, condition_group, outcome, seen_at FROM ebay_live.market_preview ORDER BY legacy_item_id",
    );
    expect(preview.rows).toEqual([
      { legacy_item_id: "900000000001", title: "Portrait lens 85mm f/1.8", landed_cents: 20_500, condition_group: "used", outcome: "match", seen_at: NOW },
      { legacy_item_id: "900000000002", title: "Portrait lens 85mm f/1.8", landed_cents: 23_000, condition_group: "used", outcome: "match", seen_at: NOW },
      { legacy_item_id: "900000000003", title: "Portrait lens 85mm f/1.8", landed_cents: null, condition_group: "used", outcome: "unknown_shipping", seen_at: NOW },
      { legacy_item_id: "900000000004", title: "Objektivdeckel 58mm", landed_cents: 5_000, condition_group: "used", outcome: "missing_word", seen_at: NOW },
      { legacy_item_id: "900000000005", title: "85mm Objektiv mit Adapter", landed_cents: 10_000, condition_group: "used", outcome: "excluded_word", seen_at: NOW },
      { legacy_item_id: "900000000006", title: "Portrait lens 85mm f/1.8", landed_cents: 31_000, condition_group: "new", outcome: "wrong_condition", seen_at: NOW },
    ]);
  });

  it("names the product's category from the snapshot while it has no name, and keeps a name it has (spec 2.1)", async () => {
    const unnamed = await createLens();
    const named = await createLens({ name: "Road bike", categoryId: "177831", categoryName: "Rennräder", searchWords: ["rennrad"], mustWords: [["rennrad"]] });
    await db.admin.query("DELETE FROM app.market_request");
    const { ebay, run } = setup();
    ebay.searchPages(
      searchPage([lens("200.00")]),
      searchPage([itemSummary({ title: "Rennrad Carbon", categoryId: "177831", price: "900.00" })]),
    );

    await run(unnamed.id);
    await run(named.id);

    const names = await db.admin.query("SELECT key, category_name FROM app.product ORDER BY category_id DESC");
    expect(names.rows).toEqual([
      { key: unnamed.key, category_name: "Synthetic category" },
      { key: named.key, category_name: "Rennräder" },
    ]);
  });

  it("sends nothing and stores nothing when the reservation is refused, and records the run as quota_refused", async () => {
    const product = await createLens();
    await db.admin.query("DELETE FROM app.market_request");
    const { ebay, reserve, log, run } = setup();
    reserve.refuse();

    await run(product.id);

    expect(reserve.reservations).toHaveLength(1);
    expect(ebay.searches()).toEqual([]);
    expect(await values()).toEqual([]);
    expect(await runs()).toEqual([{ status: "quota_refused", calls: 0, pages: 0, total: null, error_kind: null }]);
    expect(log.events("market_snapshot")).toEqual([
      expect.objectContaining({ product: product.key, kind: "nightly", status: "quota_refused", calls: 0, pages: 0 }),
    ]);
  });
});

// A full page of 200 asks, all listed two days before the run, with a next link.
const fullPage = (offset: number, total: number) =>
  searchPage(
    Array.from({ length: 200 }, (_, i) => lens(`${200 + ((offset + i) % 50)}.00`)),
    { next: true, offset, total },
  );

describe("market-snapshot handler, paging (spec 6.3)", () => {
  it("reads pages 2 and 3 while the unread asks could carry over 10 % of the weight, stops at 3 pages and marks the value capped", async () => {
    const product = await createLens({ conditionIds: ["3000"] });
    await db.admin.query("DELETE FROM app.market_request");
    const { ebay, reserve, run } = setup();
    ebay.searchPages(fullPage(0, 2000), fullPage(200, 2000), fullPage(400, 2000), fullPage(600, 2000));

    await run(product.id);

    expect(ebay.searches().map((url) => url.searchParams.get("offset"))).toEqual([null, "200", "400"]);
    expect(reserve.reservations).toHaveLength(3);
    expect(await runs()).toEqual([{ status: "ok", calls: 3, pages: 3, total: 2000, error_kind: null }]);
    expect(await values()).toEqual([
      expect.objectContaining({ condition_group: "used", n: 600, capped: true }),
    ]);
  });

  it("reads one page when the unread asks would carry less than 10 % of the weight", async () => {
    const product = await createLens({ conditionIds: ["3000"] });
    await db.admin.query("DELETE FROM app.market_request");
    const { ebay, run } = setup();
    // 10 unread asks, none newer than the oldest read: 10 / 210 of the weight at most.
    ebay.searchPages(fullPage(0, 210), fullPage(200, 210));

    await run(product.id);

    expect(ebay.searches()).toHaveLength(1);
    expect(await values()).toEqual([expect.objectContaining({ n: 200, capped: false })]);
  });

  it("stops at the first refused reservation and keeps the stored value as it was", async () => {
    const product = await createLens({ conditionIds: ["3000"] });
    await db.admin.query("DELETE FROM app.market_request");
    const { ebay, reserve, run } = setup();
    ebay.searchPages(fullPage(0, 2000), fullPage(200, 2000));
    ebay.beforeSearch(() => reserve.refuse());

    await run(product.id);

    expect(ebay.searches()).toHaveLength(1);
    expect(reserve.reservations).toHaveLength(2);
    expect(await runs()).toEqual([{ status: "quota_refused", calls: 1, pages: 1, total: 2000, error_kind: null }]);
    expect(await values()).toEqual([]);
    const listings = await db.admin.query("SELECT count(*)::int AS n FROM app.market_listing");
    expect(listings.rows).toEqual([{ n: 0 }]);
  });

  it("checks the job's abort signal before each page's reservation, so no page is reserved after the deadline", async () => {
    const product = await createLens({ conditionIds: ["3000"] });
    await db.admin.query("DELETE FROM app.market_request");
    const { ebay, reserve, run } = setup();
    const deadline = new AbortController();
    ebay.searchPages(fullPage(0, 2000), fullPage(200, 2000));
    ebay.beforeSearch(() => deadline.abort());

    await run(product.id, deadline.signal);

    expect(reserve.reservations).toHaveLength(1);
    expect(await runs()).toEqual([{ status: "error", calls: 1, pages: 1, total: 2000, error_kind: "deadline" }]);
  });
});

async function requests() {
  const result = await db.admin.query<{ reason: string; status: string; done_at: Date | null }>(
    "SELECT reason, status, done_at FROM app.market_request ORDER BY requested_at, id",
  );
  return result.rows;
}

describe("market-snapshot handler, extra snapshots from market_request (spec 5.4, 6.3)", () => {
  it("serves the product's request with p_min_left 2,500 and one of the day's 20 slots, then marks it done", async () => {
    const product = await createLens({ status: "draft" });
    const { ebay, reserve, run } = setup();
    ebay.searchPages(searchPage([lens("200.00")]));

    await run(product.id);

    expect(reserve.reservations).toEqual([
      { resource: "buy.browse", callClass: "standard", purpose: "market_extra", minLeft: 2500 },
    ]);
    const daily = await db.admin.query("SELECT day_berlin::text AS day, extra_snapshots FROM app.market_daily");
    expect(daily.rows).toEqual([{ day: "2026-10-22", extra_snapshots: 1 }]);
    expect(await requests()).toEqual([{ reason: "created", status: "done", done_at: NOW }]);
    expect(await runs()).toEqual([{ status: "ok", calls: 1, pages: 1, total: 1, error_kind: null }]);
  });

  it("records an eBay failure on the run, refuses the request and ends the job without a throw", async () => {
    const product = await createLens();
    const { ebay, run } = setup();
    ebay.respondToSearch(
      () => new Response("busy", { status: 503 }),
      () => new Response("busy", { status: 503 }),
    );

    await run(product.id);

    expect(await runs()).toEqual([{ status: "error", calls: 2, pages: 0, total: null, error_kind: "server_error" }]);
    expect(await requests()).toEqual([{ reason: "created", status: "refused", done_at: NOW }]);
    expect(await values()).toEqual([]);
  });

  it("reserves nothing once the job's deadline has passed, and records the run as a deadline error without a throw", async () => {
    const product = await createLens();
    const { ebay, reserve, run } = setup();
    const aborted = new AbortController();
    aborted.abort();

    await run(product.id, aborted.signal);

    expect(reserve.reservations).toEqual([]);
    expect(ebay.searches()).toEqual([]);
    expect(await runs()).toEqual([{ status: "error", calls: 0, pages: 0, total: null, error_kind: "deadline" }]);
    expect(await requests()).toEqual([{ reason: "created", status: "refused", done_at: NOW }]);
  });

  it("refuses the request without an eBay call when the day's 20 extra snapshots are used", async () => {
    const product = await createLens();
    await db.admin.query("INSERT INTO app.market_daily (day_berlin, extra_snapshots) VALUES ('2026-10-22', 20)");
    const { ebay, reserve, run } = setup();

    await run(product.id);

    expect(reserve.reservations).toEqual([]);
    expect(ebay.searches()).toEqual([]);
    expect(await requests()).toEqual([{ reason: "created", status: "refused", done_at: NOW }]);
    expect(await runs()).toEqual([{ status: "quota_refused", calls: 0, pages: 0, total: null, error_kind: "daily_cap" }]);
  });
});

describe("market-snapshot handler, a rules change during the snapshot (spec 6.3)", () => {
  it("discards the snapshot when the product's match_version changed before the value is stored", async () => {
    const product = await createLens({ conditionIds: ["3000"] });
    await db.admin.query("DELETE FROM app.market_request");
    const { ebay, run } = setup();
    ebay.searchPages(searchPage([lens("200.00"), lens("220.00")]));
    ebay.beforeSearch(() => saveLens(product, { conditionIds: ["3000"], mustWords: [["85mm"], ["objektiv", "lens"]] }));

    await run(product.id);

    expect(await values()).toEqual([]);
    expect(await runs()).toEqual([{ status: "discarded", calls: 1, pages: 1, total: 2, error_kind: null }]);
    const listings = await db.admin.query("SELECT count(*)::int AS n FROM app.market_listing");
    expect(listings.rows).toEqual([{ n: 0 }]);
    // The save asked for a snapshot of the new rules.
    const requests = await db.admin.query("SELECT reason, status FROM app.market_request");
    expect(requests.rows).toEqual([{ reason: "rules_changed", status: "open" }]);
  });

  it("opens the served request again, so the next tick snapshots the new rules", async () => {
    const product = await createLens({ conditionIds: ["3000"] });
    const { ebay, run } = setup();
    ebay.searchPages(searchPage([lens("200.00")]));
    ebay.beforeSearch(() => saveLens(product, { conditionIds: ["3000"], mustWords: [["85mm"], ["objektiv", "lens"]] }));

    await run(product.id);

    expect(await values()).toEqual([]);
    expect(await requests()).toEqual([{ reason: "created", status: "open", done_at: null }]);
  });
});

describe("market calls are shed before polls (spec 5.4)", () => {
  it("with 2,600 units used today, refuses a check-now while a nightly snapshot and a poll go through", async () => {
    const clock = createTestClock(new Date());
    await db.admin.query(
      `INSERT INTO app.ebay_quota_window (resource, window_start, window_end, limit_total, used, used_standard)
       VALUES ('buy.browse', date_trunc('day', now(), 'UTC'), date_trunc('day', now(), 'UTC') + interval '24 hours', 5000, 2600, 2600)`,
    );
    const product = await createLens({ conditionIds: ["3000"] });
    await db.admin.query("UPDATE app.market_request SET reason = 'check_now'");
    const ebay = createFakeEbay();
    const log = createTestLog();
    // The real reserve_ebay_call on the test database.
    const reserve = (reservation: EbayCallReservation) => reserveEbayCall(db.pool, { ...reservation, now: clock.now() });
    const snapshotDeps: MarketSnapshotDeps = {
      pool: db.pool,
      clock,
      reserve,
      createSearch: testSearch(ebay, clock),
      itemKey: createItemKey(ITEM_KEY_SECRET),
      postalCode: "80331",
      log: log.log,
    };
    const job = { id: "job-1", retryCount: 0, signal: new AbortController().signal };

    await createMarketSnapshotHandler(snapshotDeps)({ productId: product.id }, job);
    expect(ebay.searches()).toHaveLength(0);
    expect((await requests()).map((r) => [r.reason, r.status])).toEqual([["check_now", "refused"]]);

    await createMarketSnapshotHandler(snapshotDeps)({ productId: product.id }, job);
    expect(ebay.searches()).toHaveLength(1);

    const search = await db.admin.query<{ search_id: string }>("SELECT search_id FROM app.search_product WHERE product_id = $1", [
      product.id,
    ]);
    const pollDeps: SearchDeps = {
      ...snapshotDeps,
      queue: { send: async () => "job" },
      settingsEnv: SETTINGS_ENV,
    };
    await createPollHandler(pollDeps)({ searchId: search.rows[0]?.search_id ?? "" }, job);
    expect(ebay.searches()).toHaveLength(2);
    const usage = await db.admin.query("SELECT purpose, calls FROM app.api_usage_hourly ORDER BY purpose");
    expect(usage.rows).toEqual([
      { purpose: "market_nightly", calls: 1 },
      { purpose: "poll", calls: 1 },
    ]);
    expect(await runs()).toEqual([
      { status: "quota_refused", calls: 0, pages: 0, total: null, error_kind: null },
      { status: "ok", calls: 1, pages: 1, total: 0, error_kind: null },
    ]);
  });
});

describe("market-snapshot handler, products that take no snapshot (spec 9)", () => {
  it("makes no call for an archived product, one without its eBay source or one that is gone, and refuses its request", async () => {
    const archived = await createLens({ status: "draft" });
    const noEbay = await createLens({ name: "Road bike", categoryId: "177831", searchWords: ["rennrad"], mustWords: [["rennrad"]] });
    await db.admin.query("UPDATE app.product SET status = 'archived' WHERE id = $1", [archived.id]);
    await db.admin.query("UPDATE app.product_source SET enabled = false WHERE product_id = $1", [noEbay.id]);
    const { ebay, reserve, log, run } = setup();

    await run(archived.id);
    await run(noEbay.id);
    await run("01890a5d-ac96-774b-bcce-b302099a8057");

    expect(reserve.reservations).toEqual([]);
    expect(ebay.searches()).toEqual([]);
    expect(await runs()).toEqual([]);
    expect((await requests()).map((r) => r.status)).toEqual(["refused", "refused"]);
    expect(log.events("market_snapshot_skipped")).toHaveLength(3);
  });
});
