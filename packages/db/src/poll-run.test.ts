import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  finishPollRun,
  listSearches,
  loadSearch,
  okMarketValuesBetween,
  overflowPagesSince,
  recentPollRuns,
  recentSweepRuns,
  startPollRun,
} from "./poll-run.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

const T0 = new Date("2026-10-21T10:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const finished = {
  status: "ok" as const,
  finishedAt: at(5),
  pages: 1,
  items: 200,
  malformed: 1,
  newItems: 12,
  candidates: 2,
  capReached: false,
  warningIds: [12001],
  errorKind: null,
  calls: 1,
};

describe("startPollRun and finishPollRun", () => {
  it("commits the running row before the handler goes on, and finishes it once", async () => {
    const id = await startPollRun(database.pool, { kind: "poll", feedId: "s1", baseline: true, startedAt: T0 });

    // Another session sees the row at once: it is committed, not part of an open transaction.
    const other = new pg.Client({ connectionString: database.url });
    await other.connect();
    try {
      const seen = await other.query("SELECT status, baseline, started_at, finished_at FROM app.poll_run WHERE id = $1", [id]);
      expect(seen.rows).toEqual([{ status: "running", baseline: true, started_at: T0, finished_at: null }]);
    } finally {
      await other.end();
    }

    expect(await finishPollRun(database.pool, id, finished)).toBe(true);
    expect(await finishPollRun(database.pool, id, { ...finished, status: "error", errorKind: "deadline" })).toBe(false);
    const row = await database.pool.query("SELECT * FROM app.poll_run WHERE id = $1", [id]);
    expect(row.rows[0]).toMatchObject({
      status: "ok",
      finished_at: at(5),
      pages: 1,
      items: 200,
      malformed: 1,
      new_items: 12,
      candidates: 2,
      cap_reached: false,
      warning_ids: [12001],
      error_kind: null,
      calls: 1,
    });
  });
});

describe("recentPollRuns, recentSweepRuns and overflowPagesSince", () => {
  it("return the runs of one search or product newest first, and count pages beyond page 1 since a time", async () => {
    await database.pool.query("TRUNCATE app.poll_run");
    // v2: a poll's feed_id is its search id; a sweep's feed_id and segment are the product key.
    const poll = async (startedAtS: number, pages: number) => {
      const id = await startPollRun(database.pool, { kind: "poll", feedId: "s2", baseline: false, startedAt: at(startedAtS) });
      await finishPollRun(database.pool, id, { ...finished, finishedAt: at(startedAtS + 2), pages });
    };
    await poll(0, 3);
    await poll(120, 1);
    await poll(240, 2);
    const running = await startPollRun(database.pool, { kind: "poll", feedId: "s2", baseline: false, startedAt: at(360) });
    await startPollRun(database.pool, { kind: "poll", feedId: "s1", baseline: false, startedAt: at(400) });
    await startPollRun(database.pool, { kind: "sweep", feedId: "p_k3x9ab2cde", segment: "p_k3x9ab2cde", startedAt: at(500) });

    const runs = await recentPollRuns(database.pool, "s2", 3);
    const sweeps = await recentSweepRuns(database.pool, "p_k3x9ab2cde", 5);

    expect(running).toMatch(/^[0-9a-f-]{36}$/);
    expect(runs).toEqual([
      { status: "running", startedAt: at(360), finishedAt: null },
      { status: "ok", startedAt: at(240), finishedAt: at(242) },
      { status: "ok", startedAt: at(120), finishedAt: at(122) },
    ]);
    expect(sweeps).toEqual([{ status: "running", startedAt: at(500), finishedAt: null }]);
    expect(await overflowPagesSince(database.pool, "s2", at(0))).toBe(3);
    expect(await overflowPagesSince(database.pool, "s2", at(1))).toBe(1);
    expect(await overflowPagesSince(database.pool, "s3", at(0))).toBe(0);
  });
});

async function newProduct(key: string): Promise<string> {
  const result = await database.pool.query<{ id: string }>(
    `INSERT INTO app.product (key, name, description, category_id, condition_ids, search_words, must_words, price_mode,
       max_cents, sweep_minute, buyer_profile)
     VALUES ($1, 'n', 'd', '31388', '{3000}', '{w}', '[["w"]]', 'fixed', 100000, 1, 'company') RETURNING id`,
    [key],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("no product inserted");
  return id;
}

async function newSearch(id: string, change: { enabled?: boolean; retired?: boolean } = {}, members: string[] = []) {
  await database.pool.query(
    `INSERT INTO app.search (id, category_id, condition_ids, q, floor_eur, ceiling_eur, day_interval_s, night_interval_s,
       enabled, retired_at, members_hash)
     VALUES ($1, '31388', '{1000,3000}', '(85mm,portrait)', 120, 900, 300, 600, $2, $3, '')`,
    [id, change.enabled ?? true, change.retired ? T0 : null],
  );
  for (const productId of members) {
    await database.pool.query("INSERT INTO app.search_product (search_id, product_id) VALUES ($1, $2)", [id, productId]);
  }
}

describe("listSearches (spec 2.3)", () => {
  it("returns the searches that are not retired, by id number, with their member products", async () => {
    const lens = await newProduct("p_lens");
    const camera = await newProduct("p_camera");
    await newSearch("s10", {}, [lens, camera]);
    await newSearch("s9", { enabled: false }, [lens]);
    await newSearch("s8", { retired: true });

    expect(await listSearches(database.pool)).toEqual([
      {
        id: "s9",
        categoryId: "31388",
        conditionIds: ["1000", "3000"],
        q: "(85mm,portrait)",
        floorEur: 120,
        ceilingEur: 900,
        dayIntervalS: 300,
        nightIntervalS: 600,
        enabled: false,
        retired: false,
        productIds: [lens],
      },
      expect.objectContaining({ id: "s10", enabled: true, productIds: [lens, camera].sort() }),
    ]);
  });

  it("loads one search by id, a retired one too, and null for an id that never existed", async () => {
    await newSearch("s20", { retired: true });

    expect(await loadSearch(database.pool, "s20")).toMatchObject({ id: "s20", retired: true, enabled: true, productIds: [] });
    expect(await loadSearch(database.pool, "s21")).toBeNull();
  });
});

describe("okMarketValuesBetween (spec 6.4)", () => {
  it("returns per product the ok values computed in the window, oldest first, for resolveLimit to pick from", async () => {
    const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);
    const lens = await newProduct("p_lens_values");
    const bike = await newProduct("p_bike_values");
    const other = await newProduct("p_other_values");
    const value = async (productId: string, group: string, computedAt: Date, status: string, valueCents: number | null) => {
      const result = await database.pool.query<{ id: string }>(
        `INSERT INTO app.market_value (product_id, condition_group, match_version, computed_at, method_version, status, capped,
           n, neff, value_cents)
         VALUES ($1, $2, 2, $3, 'mv-1', $4, false, 20, 18, $5) RETURNING id`,
        [productId, group, computedAt, status, valueCents],
      );
      return result.rows[0]?.id;
    };
    const lensOld = await value(lens, "used", days(-2), "ok", 61200);
    const lensNew = await value(lens, "new", days(-1), "ok", 89000);
    await value(lens, "used", days(-9), "ok", 60000);
    await value(lens, "used", days(-1), "rough", 64000);
    await value(lens, "used", T0, "ok", 63000);
    const bikeUsed = await value(bike, "used", days(-3), "ok", 150000);
    await value(other, "used", days(-1), "ok", 1000);

    const values = await okMarketValuesBetween(database.pool, [lens, bike], days(-8), T0);

    expect(values).toEqual(
      new Map([
        [
          lens,
          [
            { id: lensOld, conditionGroup: "used", matchVersion: 2, computedAt: days(-2), status: "ok", capped: false, valueCents: 61200 },
            { id: lensNew, conditionGroup: "new", matchVersion: 2, computedAt: days(-1), status: "ok", capped: false, valueCents: 89000 },
          ],
        ],
        [bike, [{ id: bikeUsed, conditionGroup: "used", matchVersion: 2, computedAt: days(-3), status: "ok", capped: false, valueCents: 150000 }]],
      ]),
    );
  });
});
