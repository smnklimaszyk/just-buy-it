import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { insertClassifierSamples, insertPriceSamples, priceSamplesSince } from "./price-sample.js";
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

describe("insertPriceSamples and priceSamplesSince", () => {
  it("stores metadata only and reads one segment's samples from a time on, unknown shipping kept as NULL", async () => {
    await insertPriceSamples(database.pool, [
      { segment: "ram_ddr4", feedId: "ram", priceCents: 9000, shippingCents: 500, landedCents: 9500, totalGb: 32, seenAt: at(0) },
      { segment: "ram_ddr4", feedId: "ram", priceCents: 12000, shippingCents: null, landedCents: null, totalGb: 64, seenAt: at(60) },
      { segment: "ram_ddr5", feedId: "ram", priceCents: 15000, shippingCents: 0, landedCents: 15000, totalGb: 32, seenAt: at(60) },
    ]);
    await insertPriceSamples(database.pool, []);

    expect(await priceSamplesSince(database.pool, "ram_ddr4", at(0))).toEqual([
      { landedCents: 9500, totalGb: 32 },
      { landedCents: null, totalGb: 64 },
    ]);
    expect(await priceSamplesSince(database.pool, "ram_ddr4", at(1))).toEqual([{ landedCents: null, totalGb: 64 }]);
  });
});

describe("insertClassifierSamples", () => {
  it("keeps all accepted and the first 20 rejected titles per feed and hour, each for 6 h", async () => {
    const rejected = (n: number, seenAt: Date) => ({
      feedId: "gpu" as const,
      segment: null,
      title: `rejected ${n}`,
      landedCents: 10000 + n,
      outcome: "rejected" as const,
      reason: "wrong_model" as const,
      seenAt,
    });
    const accepted = { feedId: "gpu" as const, segment: "gpu_3090" as const, title: "accepted", landedCents: 45000, outcome: "candidate" as const, reason: null, seenAt: at(0) };

    await insertClassifierSamples(database.pool, [...Array.from({ length: 15 }, (_, n) => rejected(n, at(0))), accepted]);
    await insertClassifierSamples(database.pool, [...Array.from({ length: 15 }, (_, n) => rejected(15 + n, at(60))), { ...accepted, seenAt: at(60) }]);
    await insertClassifierSamples(database.pool, [rejected(99, at(3600))]);
    await insertClassifierSamples(database.pool, [{ ...rejected(98, at(60)), feedId: "pc" }]);

    const rows = await database.pool.query<{ feed_id: string; outcome: string; n: number; first: string; last: string }>(
      `SELECT feed_id, outcome, count(*)::int AS n, min(title) AS first, max(expires_at - seen_at)::text AS last
         FROM ebay_live.classifier_sample GROUP BY feed_id, outcome ORDER BY feed_id, outcome`,
    );
    expect(rows.rows).toEqual([
      { feed_id: "gpu", outcome: "candidate", n: 2, first: "accepted", last: "06:00:00" },
      { feed_id: "gpu", outcome: "rejected", n: 21, first: "rejected 0", last: "06:00:00" },
      { feed_id: "pc", outcome: "rejected", n: 1, first: "rejected 98", last: "06:00:00" },
    ]);
    const kept = await database.pool.query<{ title: string }>(
      "SELECT title FROM ebay_live.classifier_sample WHERE feed_id = 'gpu' AND outcome = 'rejected' ORDER BY seen_at DESC, title DESC LIMIT 2",
    );
    expect(kept.rows.map((row) => row.title)).toEqual(["rejected 99", "rejected 19"]);
  });
});
