import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { createFakeEbay, createFakeReserve, json, testSearch } from "../testing/ebay.js";
import { createTestLog } from "../testing/log.js";
import { createCategorySuggestHandler, type CategorySuggestDeps } from "./category-suggest.js";

const NOW = new Date("2026-10-22T09:00:00.000Z");

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.admin.query("TRUNCATE app.category_request, app.market_daily");
});

async function insertRequest(q: string, status = "queued"): Promise<string> {
  const result = await db.admin.query<{ id: string }>("INSERT INTO app.category_request (q, status) VALUES ($1, $2) RETURNING id", [
    q,
    status,
  ]);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("no request id");
  return id;
}

async function request(id: string) {
  const result = await db.admin.query<{ status: string; result: unknown; done_at: Date | null }>(
    "SELECT status, result, done_at FROM app.category_request WHERE id = $1",
    [id],
  );
  return result.rows[0];
}

// A refinements-only answer, as eBay sends it for fieldgroups=CATEGORY_REFINEMENTS.
const refinements = (categories: Record<string, unknown>[]) =>
  json({ total: 900, limit: 1, offset: 0, refinement: { dominantCategoryId: "177831", categoryDistributions: categories } });

function setup(overrides: Partial<CategorySuggestDeps> = {}) {
  const clock = createTestClock(NOW);
  const ebay = createFakeEbay();
  const reserve = createFakeReserve();
  const log = createTestLog();
  const deps: CategorySuggestDeps = {
    pool: db.pool,
    clock,
    reserve: reserve.reserve,
    createSearch: testSearch(ebay, clock),
    log: log.log,
    ...overrides,
  };
  const job = { id: "category-1", retryCount: 0, signal: new AbortController().signal };
  return { ebay, reserve, log, run: (requestId: string) => createCategorySuggestHandler(deps)({ requestId }, job) };
}

describe("category-suggest handler (spec 6.6)", () => {
  it("runs one search for the words and stores the 5 categories with the most matches, with their names", async () => {
    const id = await insertRequest("(rennrad,carbon)");
    const { ebay, reserve, run } = setup();
    ebay.respondToSearch(() =>
      refinements([
        { categoryId: "177831", categoryName: "Rennräder", matchCount: 412, refinementHref: "https://api.ebay.test/x" },
        { categoryId: "177837", categoryName: "Rahmen", matchCount: 51 },
        { categoryId: "22679", categoryName: "Laufräder", matchCount: 88 },
        { categoryId: "177835", categoryName: "Mountainbikes", matchCount: 9 },
        { categoryId: "57270", categoryName: "Bekleidung", matchCount: 120 },
        { categoryId: "36125", categoryName: "Fahrradcomputer", matchCount: 3 },
        { categoryId: "177832", categoryName: "Gravelbikes", matchCount: 64 },
      ]),
    );

    await run(id);

    expect(reserve.reservations).toEqual([
      { resource: "buy.browse", callClass: "standard", purpose: "category_suggest", minLeft: 2500 },
    ]);
    const url = ebay.searches()[0];
    expect(url?.searchParams.get("q")).toBe("(rennrad,carbon)");
    expect(url?.searchParams.get("fieldgroups")).toBe("CATEGORY_REFINEMENTS");
    expect(url?.searchParams.get("limit")).toBe("1");
    expect(url?.searchParams.has("category_ids")).toBe(false);
    expect(await request(id)).toEqual({
      status: "done",
      done_at: NOW,
      result: {
        categories: [
          { categoryId: "177831", categoryName: "Rennräder", matchCount: 412 },
          { categoryId: "57270", categoryName: "Bekleidung", matchCount: 120 },
          { categoryId: "22679", categoryName: "Laufräder", matchCount: 88 },
          { categoryId: "177832", categoryName: "Gravelbikes", matchCount: 64 },
          { categoryId: "177837", categoryName: "Rahmen", matchCount: 51 },
        ],
      },
    });
  });

  it("takes one of the day's 20 extra-snapshot slots, and refuses without a call when they are used", async () => {
    const first = await insertRequest("rennrad");
    const second = await insertRequest("kinderwagen");
    const { ebay, reserve, run } = setup();
    ebay.respondToSearch(() => refinements([{ categoryId: "177831", categoryName: "Rennräder", matchCount: 4 }]));

    await run(first);
    const daily = await db.admin.query("SELECT day_berlin::text AS day, extra_snapshots FROM app.market_daily");
    expect(daily.rows).toEqual([{ day: "2026-10-22", extra_snapshots: 1 }]);

    await db.admin.query("UPDATE app.market_daily SET extra_snapshots = 20");
    await run(second);

    expect(reserve.reservations).toHaveLength(1);
    expect(ebay.searches()).toHaveLength(1);
    expect(await request(second)).toEqual({ status: "refused", result: null, done_at: NOW });
  });

  it("refuses the request when the reservation is refused or eBay fails, and ends the job without a throw", async () => {
    const quota = await insertRequest("rennrad");
    const failing = await insertRequest("kinderwagen");
    const { ebay, reserve, log, run } = setup();
    ebay.respondToSearch(() => json({ errors: [{ errorId: 12001 }] }, 400));

    await run(failing);
    reserve.refuse();
    await run(quota);

    expect(ebay.searches()).toHaveLength(1);
    expect(await request(failing)).toEqual({ status: "refused", result: null, done_at: NOW });
    expect(await request(quota)).toEqual({ status: "refused", result: null, done_at: NOW });
    expect(log.events("category_suggest_refused").map((e) => e.reason)).toEqual(["client_error", "quota_refused"]);
  });

  it("refuses words the search builder refuses, before any reservation, and never logs them", async () => {
    const id = await insertRequest("rennrad -q-sentinel");
    const { ebay, reserve, log, run } = setup();

    await run(id);

    expect(reserve.reservations).toEqual([]);
    expect(ebay.searches()).toEqual([]);
    expect(await request(id)).toEqual({ status: "refused", result: null, done_at: NOW });
    expect(log.events("category_suggest_refused")).toEqual([
      { event: "category_suggest_refused", request_id: id, reason: "invalid_words" },
    ]);
    expect(log.text()).not.toContain("q-sentinel");
  });

  it("does nothing for a request that is gone or already finished", async () => {
    const done = await insertRequest("rennrad");
    await db.admin.query("UPDATE app.category_request SET status = 'done', done_at = $2 WHERE id = $1", [done, NOW]);
    const { ebay, run } = setup();

    await run(done);
    await run("01890a5d-ac96-774b-bcce-b302099a8057");

    expect(ebay.searches()).toEqual([]);
    expect(await request(done)).toEqual({ status: "done", result: null, done_at: NOW });
  });
});
