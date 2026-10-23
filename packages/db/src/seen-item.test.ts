import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { claimCandidate, getSeenItems, upsertSeenItems } from "./seen-item.js";
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
const key = (n: number) => n.toString(16).padStart(64, "0");

describe("upsertSeenItems and getSeenItems", () => {
  it("inserts first sightings, moves last_seen_at and outcome on later ones, and keeps a candidate a candidate", async () => {
    await upsertSeenItems(database.pool, [
      { itemKey: key(1), keyVersion: 1, feedId: "gpu", segment: "gpu_3090", outcome: "above_max", seenAt: at(0) },
      { itemKey: key(2), keyVersion: 1, feedId: "gpu", segment: null, outcome: "wrong_model", seenAt: at(0) },
    ]);
    await database.pool.query("UPDATE app.seen_item SET outcome = 'candidate', candidate_at = $2 WHERE item_key = $1", [key(2), at(1)]);

    await upsertSeenItems(database.pool, [
      { itemKey: key(1), keyVersion: 1, feedId: "gpu", segment: "gpu_3090", outcome: "over_cap", seenAt: at(60) },
      { itemKey: key(2), keyVersion: 1, feedId: "gpu", segment: "gpu_4090", outcome: "above_max", seenAt: at(60) },
    ]);
    const seen = await getSeenItems(database.pool, [key(1), key(2), key(3)]);

    expect([...seen.entries()]).toEqual([
      [key(1), { feedId: "gpu", segment: "gpu_3090", outcome: "over_cap", firstSeenAt: at(0), lastSeenAt: at(60), candidateAt: null }],
      [key(2), { feedId: "gpu", segment: "gpu_4090", outcome: "candidate", firstSeenAt: at(0), lastSeenAt: at(60), candidateAt: at(1) }],
    ]);
  });
});

describe("claimCandidate", () => {
  it("claims an item once, even from two sessions at the same time", async () => {
    // v2: the search id in feed_id, the product key in segment.
    await upsertSeenItems(database.pool, [
      { itemKey: key(10), keyVersion: 1, feedId: "s3", segment: "p_k3x9ab2cde", outcome: "above_max", seenAt: at(0) },
    ]);

    const claims = await Promise.all([
      claimCandidate(database.pool, key(10), at(5)),
      claimCandidate(database.pool, key(10), at(6)),
    ]);
    const later = await claimCandidate(database.pool, key(10), at(7));
    const unknown = await claimCandidate(database.pool, key(11), at(7));

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(later).toBe(false);
    expect(unknown).toBe(false);
    expect((await getSeenItems(database.pool, [key(10)])).get(key(10))).toMatchObject({
      feedId: "s3",
      segment: "p_k3x9ab2cde",
      outcome: "candidate",
    });
  });
});
