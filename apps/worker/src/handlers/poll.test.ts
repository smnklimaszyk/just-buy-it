import type { JobQueue } from "@ebay-sniper/db/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createItemKey } from "../item-key.js";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { createFakeEbay, createFakeReserve, gpuSummary, hang, pcSummary, searchPage, testSearch } from "../testing/ebay.js";
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
  await db.admin.query("UPDATE app.feed SET enabled = true");
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

describe("poll handler, first poll of a feed (section 3.2 baseline)", () => {
  it("is a baseline: page 1 only, in-band items seen as baseline, price samples, no candidate and no enrich job", async () => {
    const { ebay, poll, job } = setup();
    const created = new Date(NOW.getTime() - HOUR_MS).toISOString();
    ebay.searchPages(
      searchPage(
        [
          gpuSummary({ title: "RTX 3090 Founders Edition 24GB", price: "450.00", itemCreationDate: created }),
          gpuSummary({ title: "RTX 4090 Gaming OC", price: "1900.00", itemCreationDate: created }),
          gpuSummary({ title: "Wasserkühler für RTX 4090", price: "300.00", itemCreationDate: created }),
        ],
        { next: true },
      ),
    );

    await poll({ feedId: "gpu" }, job());

    expect(ebay.searches()).toHaveLength(1);
    expect(await rows("SELECT kind, baseline, status, pages, items, new_items, candidates, calls FROM app.poll_run")).toEqual([
      { kind: "poll", baseline: true, status: "ok", pages: 1, items: 3, new_items: 3, candidates: 0, calls: 1 },
    ]);
    // An item the baseline rejects keeps its reason, so a later price drop into the band alerts.
    expect(await rows("SELECT outcome FROM app.seen_item ORDER BY outcome")).toEqual([
      { outcome: "above_max" },
      { outcome: "accessory" },
      { outcome: "baseline" },
    ]);
    expect(await rows("SELECT segment, price_cents FROM app.price_sample ORDER BY price_cents")).toEqual([
      { segment: "gpu_3090", price_cents: 45000 },
      { segment: "gpu_4090", price_cents: 190000 },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM app.candidate")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM ebay_live.listing")).toEqual([{ n: 0 }]);
    expect(await jobs(db, "enrich")).toEqual([]);
  });

  it("makes a candidate of an item the baseline saw above the max once its price drops into the band", async () => {
    const { ebay, poll, job } = setup();
    // Older than 24 h, so only its baseline sighting keeps it tracked.
    const created = new Date(NOW.getTime() - 30 * HOUR_MS).toISOString();
    const listing = { legacyItemId: "955500000501", title: "RTX 3090 Founders Edition 24GB", itemCreationDate: created };
    ebay.searchPages(
      searchPage([gpuSummary({ ...listing, price: "700.00" })]),
      searchPage([gpuSummary({ ...listing, price: "450.00" })]),
    );

    await poll({ feedId: "gpu" }, job());
    await poll({ feedId: "gpu" }, job());

    expect(await rows("SELECT outcome, candidate_at IS NOT NULL AS candidate FROM app.seen_item")).toEqual([
      { outcome: "candidate", candidate: true },
    ]);
    expect(await rows("SELECT price_cents FROM app.candidate")).toEqual([{ price_cents: 45000 }]);
    expect(await jobs(db, "enrich")).toHaveLength(1);
  });
});

// A feed that has polled before: one seen_item row, so the next poll is not a baseline.
async function pastBaseline(feedId: string): Promise<void> {
  const key = feedId.padEnd(64, "0").replace(/[^0-9a-f]/g, "f");
  await db.admin.query(
    `INSERT INTO app.seen_item (item_key, key_version, feed_id, outcome, first_seen_at, last_seen_at)
     VALUES ($1, 1, $2, 'baseline', $3, $3)`,
    [key, feedId, new Date(NOW.getTime() - HOUR_MS)],
  );
}

const recent = () => new Date(NOW.getTime() - HOUR_MS).toISOString();

describe("poll handler, candidates (sections 2.4, 3.2)", () => {
  it("makes an in-band item a candidate with its listing, summary content and enrich job", async () => {
    await pastBaseline("gpu");
    const { ebay, poll, job, log } = setup();
    ebay.searchPages(
      searchPage([
        gpuSummary({ title: "RTX 3090 Founders Edition 24GB", price: "450.00", shipping: "10.00", itemCreationDate: recent() }),
        gpuSummary({ title: "RTX 4090 Gaming OC", price: "1900.00", itemCreationDate: recent() }),
      ]),
    );

    await poll({ feedId: "gpu" }, job());

    const candidates = await rows<{ listing_id: string }>(
      `SELECT listing_id, segment, source, price_cents, shipping_cents, landed_cents, shipping_known, rule_version, decision
         FROM app.candidate`,
    );
    expect(candidates).toEqual([
      {
        listing_id: expect.any(String),
        segment: "gpu_3090",
        source: "poll",
        price_cents: 45000,
        shipping_cents: 1000,
        landed_cents: 46000,
        shipping_known: true,
        rule_version: 1,
        decision: "pending",
      },
    ]);
    const listingId = candidates[0]?.listing_id;
    expect(await rows("SELECT id, feed_id, segment, content_expires_at FROM ebay_live.listing")).toEqual([
      { id: listingId, feed_id: "gpu", segment: "gpu_3090", content_expires_at: new Date(NOW.getTime() + 6 * HOUR_MS) },
    ]);
    expect(await rows("SELECT listing_id, source, title, seller_feedback_score FROM ebay_live.listing_content")).toEqual([
      { listing_id: listingId, source: "summary", title: "RTX 3090 Founders Edition 24GB", seller_feedback_score: 250 },
    ]);
    expect(await jobs(db, "enrich")).toEqual([{ listingId }]);
    expect(await rows("SELECT outcome FROM app.seen_item WHERE candidate_at IS NOT NULL")).toEqual([{ outcome: "candidate" }]);
    expect(await rows("SELECT candidates, new_items FROM app.poll_run")).toEqual([{ candidates: 1, new_items: 2 }]);
    expect(log.events("candidate_created")).toEqual([
      { event: "candidate_created", listing_id: listingId, segment: "gpu_3090", source: "poll" },
    ]);
  });

  it("leaves no job and no candidate rows when the transaction fails after the enqueue", async () => {
    await pastBaseline("gpu");
    const crashing: Pick<JobQueue, "send"> = {
      async send(name, payload, options) {
        await queue.send(name, payload, options);
        throw new Error("crash before commit");
      },
    };
    const { ebay, poll, job } = setup({ queue: crashing });
    ebay.searchPages(searchPage([gpuSummary({ price: "450.00", itemCreationDate: recent() })]));

    await expect(poll({ feedId: "gpu" }, job())).rejects.toThrow("crash before commit");

    expect(await jobs(db, "enrich")).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM app.candidate")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM ebay_live.listing")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM ebay_live.listing_content")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.seen_item WHERE candidate_at IS NOT NULL")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT status, error_kind FROM app.poll_run")).toEqual([{ status: "error", error_kind: "db" }]);
  });

  it("makes one candidate of an item that two feeds see at the same time", async () => {
    await pastBaseline("gpu");
    await pastBaseline("pc");
    const same = { legacyItemId: "955500000001", title: "RTX 4090 Founders Edition 24GB", price: "1100.00", itemCreationDate: recent() };
    const gpu = setup();
    const pc = setup();
    gpu.ebay.searchPages(searchPage([gpuSummary(same)]));
    pc.ebay.searchPages(searchPage([pcSummary(same)]));

    await Promise.all([gpu.poll({ feedId: "gpu" }, gpu.job()), pc.poll({ feedId: "pc" }, pc.job())]);

    expect(await rows("SELECT count(*)::int AS n FROM app.candidate")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT count(*)::int AS n FROM ebay_live.listing")).toEqual([{ n: 1 }]);
    expect(await jobs(db, "enrich")).toHaveLength(1);
    expect(await rows("SELECT sum(candidates)::int AS n FROM app.poll_run")).toEqual([{ n: 1 }]);
  });

  it("records an in-band item first seen 25 hours after it was listed as too_old, never a candidate", async () => {
    await pastBaseline("gpu");
    const { ebay, poll, job } = setup();
    const old = gpuSummary({ price: "450.00", itemCreationDate: new Date(NOW.getTime() - 25 * HOUR_MS).toISOString() });
    ebay.searchPages(searchPage([old]), searchPage([old]));

    await poll({ feedId: "gpu" }, job());
    await poll({ feedId: "gpu" }, job());

    expect(await rows("SELECT outcome FROM app.seen_item WHERE feed_id = 'gpu' AND outcome <> 'baseline'")).toEqual([
      { outcome: "too_old" },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM app.candidate")).toEqual([{ n: 0 }]);
  });

  it("makes the 150th candidate of a segment in a Berlin day and records the 151st as over_cap", async () => {
    await pastBaseline("gpu");
    // 149 gpu_3090 candidates since Berlin midnight (22:00 UTC the day before), one just before it.
    await db.admin.query(
      `INSERT INTO app.candidate (item_key, listing_id, feed_id, segment, source, price_cents, shipping_known, rule_version, created_at)
       SELECT lpad(to_hex(n), 64, '0'), gen_random_uuid(), 'gpu', 'gpu_3090', 'poll', 45000, true, 1,
              CASE WHEN n = 0 THEN '2026-10-20T21:59:59Z'::timestamptz ELSE '2026-10-20T22:00:00Z'::timestamptz END
         FROM generate_series(0, 149) AS n`,
    );
    const { ebay, poll, job } = setup();
    ebay.searchPages(
      searchPage([
        gpuSummary({ legacyItemId: "955500000150", price: "450.00", itemCreationDate: recent() }),
        gpuSummary({ legacyItemId: "955500000151", price: "460.00", itemCreationDate: recent() }),
      ]),
    );

    await poll({ feedId: "gpu" }, job());

    const itemKey = createItemKey(ITEM_KEY_SECRET);
    const outcomes = await rows<{ item_key: string; outcome: string }>(
      "SELECT item_key, outcome FROM app.seen_item WHERE item_key = ANY($1)",
      [[itemKey("955500000150").itemKey, itemKey("955500000151").itemKey]],
    );
    expect(Object.fromEntries(outcomes.map((r) => [r.item_key, r.outcome]))).toEqual({
      [itemKey("955500000150").itemKey]: "candidate",
      [itemKey("955500000151").itemKey]: "over_cap",
    });
    expect(await rows("SELECT candidates FROM app.poll_run")).toEqual([{ candidates: 1 }]);
  });

  it("makes a tracked item a candidate once its price drops into the band, and only once", async () => {
    await pastBaseline("gpu");
    const { ebay, clock, poll, job } = setup();
    const item = { legacyItemId: "955500000300", itemCreationDate: recent() };
    ebay.searchPages(
      searchPage([gpuSummary({ ...item, price: "650.00" })]),
      searchPage([gpuSummary({ ...item, price: "480.00" })]),
      searchPage([gpuSummary({ ...item, price: "470.00" })]),
    );

    await poll({ feedId: "gpu" }, job());
    const afterFirst = await rows("SELECT outcome FROM app.seen_item WHERE feed_id = 'gpu' AND outcome <> 'baseline'");
    clock.advance(2 * 60_000);
    await poll({ feedId: "gpu" }, job());
    clock.advance(2 * 60_000);
    await poll({ feedId: "gpu" }, job());

    expect(afterFirst).toEqual([{ outcome: "above_max" }]);
    expect(await rows("SELECT price_cents FROM app.candidate")).toEqual([{ price_cents: 48000 }]);
    expect(await jobs(db, "enrich")).toHaveLength(1);
    // The third sighting only confirms the listing (section 6.3).
    expect(await rows("SELECT last_confirmed_at FROM ebay_live.listing")).toEqual([
      { last_confirmed_at: new Date(NOW.getTime() + 4 * 60_000) },
    ]);
  });
});

describe("poll handler, a disabled segment (section 3.3)", () => {
  it("makes no candidate for a segment whose rule is disabled, and one once it is enabled again", async () => {
    await pastBaseline("gpu");
    await db.admin.query("UPDATE app.segment_rule SET enabled = false WHERE segment = 'gpu_3090'");
    const { ebay, poll, job } = setup();
    const listing = { legacyItemId: "955500000601", title: "RTX 3090 Founders Edition 24GB", price: "450.00", itemCreationDate: recent() };
    const other = { legacyItemId: "955500000602", title: "RTX 4090 Gaming OC", price: "1100.00", itemCreationDate: recent() };
    ebay.searchPages(searchPage([gpuSummary(listing), gpuSummary(other)]), searchPage([gpuSummary(listing)]));

    await poll({ feedId: "gpu" }, job());

    expect(await rows("SELECT segment, outcome FROM app.seen_item WHERE segment IS NOT NULL ORDER BY segment")).toEqual([
      { segment: "gpu_3090", outcome: "segment_off" },
      { segment: "gpu_4090", outcome: "candidate" },
    ]);
    expect(await rows("SELECT segment FROM app.candidate")).toEqual([{ segment: "gpu_4090" }]);

    await db.admin.query("UPDATE app.segment_rule SET enabled = true WHERE segment = 'gpu_3090'");
    await poll({ feedId: "gpu" }, job());

    expect(await rows("SELECT segment FROM app.candidate ORDER BY segment")).toEqual([{ segment: "gpu_3090" }, { segment: "gpu_4090" }]);
  });
});

describe("poll handler, request and samples (sections 3.2, 4)", () => {
  it("searches the feed's category newest first with its price filter and the German postal code", async () => {
    const { ebay, poll, job } = setup();

    await poll({ feedId: "ram" }, job());

    const [url] = ebay.searches();
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      q: "(ddr4,ddr5)",
      category_ids: "170083",
      filter:
        "buyingOptions:{FIXED_PRICE|BEST_OFFER},conditionIds:{1500|2500|3000},deliveryCountry:DE,itemLocationCountry:DE,price:[51..1200],priceCurrency:EUR",
      sort: "newlyListed",
      limit: "200",
      offset: "0",
    });
    const search = ebay.requests.find((r) => r.kind === "search");
    expect(search?.headers["x-ebay-c-enduserctx"]).toBe("contextualLocation=country%3DDE%2Czip%3D80331");
    expect(search?.headers["x-ebay-c-marketplace-id"]).toBe("EBAY_DE");
  });

  it("samples the titles of first sightings with their reason code, and no later sighting again", async () => {
    await pastBaseline("gpu");
    const { ebay, poll, job, log } = setup();
    const page = searchPage([
      gpuSummary({ legacyItemId: "955500000401", title: "RTX 3090 Founders Edition", price: "450.00", itemCreationDate: recent() }),
      gpuSummary({ legacyItemId: "955500000402", title: "Suche RTX 3090", price: "400.00", itemCreationDate: recent() }),
      gpuSummary({ legacyItemId: "955500000403", title: "RTX 3090 Gaming", price: "500.00", currency: "USD" }),
    ]);
    ebay.searchPages(page, page);

    await poll({ feedId: "gpu" }, job());
    await poll({ feedId: "gpu" }, job());

    expect(await rows("SELECT title, segment, landed_cents, outcome, reason FROM ebay_live.classifier_sample ORDER BY title")).toEqual([
      { title: "RTX 3090 Founders Edition", segment: "gpu_3090", landed_cents: 46000, outcome: "candidate", reason: null },
      { title: "RTX 3090 Gaming", segment: null, landed_cents: null, outcome: "rejected", reason: "not_eur" },
      { title: "Suche RTX 3090", segment: null, landed_cents: 41000, outcome: "rejected", reason: "wanted_ad" },
    ]);
    expect(await rows("SELECT outcome FROM app.seen_item WHERE feed_id = 'gpu' ORDER BY outcome")).toEqual([
      { outcome: "baseline" },
      { outcome: "candidate" },
      { outcome: "not_eur" },
      { outcome: "wanted_ad" },
    ]);
    // Titles go to ebay_live only, never to the log (ADR 0024).
    expect(log.text()).not.toContain("Founders");
  });
});

describe("poll handler, pages (section 3.2)", () => {
  it("reads page 2 when page 1 was all unseen, and counts a malformed item without processing it", async () => {
    await pastBaseline("gpu");
    const { ebay, poll, job } = setup();
    const accessory = () => gpuSummary({ title: "Backplate für RTX 3090", price: "300.00", itemCreationDate: recent() });
    const page1 = Array.from({ length: 200 }, accessory);
    // No itemId: the schema refuses it.
    const page2 = [...Array.from({ length: 49 }, accessory), { title: "RTX 3090", price: { value: "450.00", currency: "EUR" } }];
    ebay.searchPages(searchPage(page1, { next: true }), searchPage(page2, { offset: 200 }));

    await poll({ feedId: "gpu" }, job());

    expect(ebay.searches().map((url) => url.searchParams.get("offset"))).toEqual(["0", "200"]);
    expect(await rows("SELECT pages, items, malformed, new_items, cap_reached, calls FROM app.poll_run")).toEqual([
      { pages: 2, items: 249, malformed: 1, new_items: 249, cap_reached: false, calls: 2 },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM app.seen_item WHERE outcome = 'accessory'")).toEqual([{ n: 249 }]);
  });

  it("stops at page 1 with cap_reached once the feed used its 20 overflow pages this Berlin day", async () => {
    await pastBaseline("gpu");
    // Earlier polls today with 2 + 2 + 16 overflow pages.
    await db.admin.query(
      `INSERT INTO app.poll_run (feed_id, kind, started_at, finished_at, status, pages)
       VALUES ('gpu', 'poll', $1, $1, 'ok', 3), ('gpu', 'poll', $1, $1, 'ok', 3), ('gpu', 'poll', $1, $1, 'ok', 17)`,
      [new Date("2026-10-20T22:30:00.000Z")],
    );
    const { ebay, poll, job } = setup();
    ebay.searchPages(searchPage([gpuSummary({ price: "300.00", title: "Backplate für RTX 3090" })], { next: true }));

    await poll({ feedId: "gpu" }, job());

    expect(ebay.searches()).toHaveLength(1);
    expect(await rows("SELECT pages, cap_reached FROM app.poll_run WHERE pages = 1")).toEqual([{ pages: 1, cap_reached: true }]);
  });

  it("reads at most 3 pages and sets cap_reached when page 3 is still all unseen", async () => {
    await pastBaseline("gpu");
    const { ebay, poll, job } = setup();
    const page = (offset: number) =>
      searchPage([gpuSummary({ price: "300.00", title: "Backplate für RTX 3090" })], { next: true, offset });
    ebay.searchPages(page(0), page(200), page(400), page(600));

    await poll({ feedId: "gpu" }, job());

    expect(ebay.searches()).toHaveLength(3);
    expect(await rows("SELECT pages, cap_reached FROM app.poll_run")).toEqual([{ pages: 3, cap_reached: true }]);
  });

  it("reads no page 2 when page 1 holds an item seen before", async () => {
    await pastBaseline("gpu");
    const { ebay, poll, job } = setup();
    const known = gpuSummary({ price: "300.00", title: "Backplate für RTX 3090" });
    const fresh = gpuSummary({ price: "310.00", title: "Backplate für RTX 3090" });
    ebay.searchPages(searchPage([known]), searchPage([known, fresh], { next: true }));

    await poll({ feedId: "gpu" }, job());
    await poll({ feedId: "gpu" }, job());

    expect(ebay.searches()).toHaveLength(2);
    expect(await rows("SELECT pages, new_items, cap_reached FROM app.poll_run ORDER BY items")).toEqual([
      { pages: 1, new_items: 1, cap_reached: false },
      { pages: 1, new_items: 1, cap_reached: false },
    ]);
  });

  it("reserves no further page once the deadline has passed, and keeps what page 1 wrote", async () => {
    await pastBaseline("gpu");
    const { ebay, reserve, poll, job } = setup();
    const deadline = new AbortController();
    ebay.beforeSearch(() => deadline.abort());
    ebay.searchPages(searchPage([gpuSummary({ price: "300.00", title: "Backplate für RTX 3090" })], { next: true }));

    await poll({ feedId: "gpu" }, job(deadline.signal));

    expect(reserve.reservations).toHaveLength(1);
    expect(await rows("SELECT status, error_kind, pages, items FROM app.poll_run")).toEqual([
      { status: "error", error_kind: "deadline", pages: 1, items: 1 },
    ]);
  });
});

describe("poll handler, run rows (section 2.3)", () => {
  it("has the running row committed before the first request", async () => {
    const { ebay, poll, job } = setup();
    const atRequest: unknown[] = [];
    ebay.beforeSearch(async () => {
      atRequest.push(...(await rows("SELECT kind, status, finished_at FROM app.poll_run")));
    });

    await poll({ feedId: "gpu" }, job());

    expect(atRequest).toEqual([{ kind: "poll", status: "running", finished_at: null }]);
  });

  it("ends a hanging request at the deadline and finishes the row as error with error_kind deadline", async () => {
    const { ebay, poll, job, log } = setup();
    ebay.respondToSearch((_url, signal) => hang(signal));

    await poll({ feedId: "gpu" }, job(AbortSignal.timeout(300)));

    expect(await rows("SELECT status, error_kind, calls, finished_at IS NOT NULL AS finished FROM app.poll_run")).toEqual([
      { status: "error", error_kind: "deadline", calls: 1, finished: true },
    ]);
    expect(log.events("poll_run")).toMatchObject([{ feed: "gpu", status: "error", error_kind: "deadline" }]);
  });

  it("records quota_refused and sends no search when the reservation is refused", async () => {
    const { ebay, reserve, poll, job, log } = setup();
    reserve.refuse();

    await poll({ feedId: "gpu" }, job());

    expect(ebay.searches()).toEqual([]);
    expect(reserve.reservations).toEqual([{ resource: "buy.browse", callClass: "standard", purpose: "poll", minLeft: 1500 }]);
    expect(await rows("SELECT status, error_kind, calls FROM app.poll_run")).toEqual([
      { status: "quota_refused", error_kind: null, calls: 0 },
    ]);
    expect(log.events("quota_refused")).toMatchObject([{ feed: "gpu", kind: "poll" }]);
  });

  it("fails the run, naming the segment, when a segment rule row is missing", async () => {
    await pastBaseline("gpu");
    await db.admin.query("DELETE FROM app.segment_rule WHERE segment = 'gpu_3090'");
    const { ebay, poll, job } = setup();
    ebay.searchPages(searchPage([gpuSummary({ price: "450.00", itemCreationDate: recent() })]));

    await expect(poll({ feedId: "gpu" }, job())).rejects.toThrow("segment gpu_3090 has no rule");
    expect(await rows("SELECT status, error_kind FROM app.poll_run")).toEqual([{ status: "error", error_kind: "db" }]);
  });

  it("records paused and sends nothing when the feed was paused after the job was queued", async () => {
    await db.admin.query("UPDATE app.feed SET enabled = false WHERE id = 'gpu'");
    const { ebay, reserve, poll, job } = setup();

    await poll({ feedId: "gpu" }, job());

    expect(ebay.requests).toEqual([]);
    expect(reserve.reservations).toEqual([]);
    expect(await rows("SELECT status, calls FROM app.poll_run")).toEqual([{ status: "paused", calls: 0 }]);
  });
});
