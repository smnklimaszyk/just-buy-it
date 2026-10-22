import { FEED_IDS, SEGMENTS, startingFeed, startingSegmentRule, type FeedId } from "@ebay-sniper/domain";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { listFeeds, listSegmentRules, updateFeed, updateSegmentRule } from "./feed.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

describe("migration 0006_seed_feeds_rules", () => {
  it("seeds the three feeds paused and the six segment rules with the starting values of section 3.3", async () => {
    expect(await listFeeds(database.pool)).toEqual(FEED_IDS.map((id) => startingFeed(id)));
    expect(await listSegmentRules(database.pool)).toEqual(SEGMENTS.map((segment) => startingSegmentRule(segment)));
    expect((await listFeeds(database.pool)).every((feed) => !feed.enabled)).toBe(true);
  });
});

const AT = new Date("2026-10-21T12:00:00.000Z");

async function auditRows(): Promise<{ at: Date; actor: string; action: string; detail: unknown }[]> {
  const result = await database.pool.query<{ at: Date; actor: string; action: string; detail: unknown }>(
    "SELECT at, actor, action, detail FROM app.audit_event ORDER BY id",
  );
  return result.rows;
}

describe("updateSegmentRule", () => {
  it("changes the fields, bumps rule_version and writes one audit_event with old and new values", async () => {
    await database.pool.query("TRUNCATE app.audit_event");

    const rule = await updateSegmentRule(
      database.pool,
      "gpu_3090",
      { maxLandedCents: 49000, floorCents: 25000 },
      { at: AT, actor: "system:cli", action: "rules.set" },
    );

    expect(rule).toMatchObject({ segment: "gpu_3090", kind: "per_item", maxLandedCents: 49000, floorCents: 25000, ruleVersion: 2 });
    expect(await auditRows()).toEqual([
      {
        at: AT,
        actor: "system:cli",
        action: "rules.set",
        detail: {
          segment: "gpu_3090",
          rule_version: { from: 1, to: 2 },
          changes: { max_landed_cents: { from: 52000, to: 49000 }, floor_cents: { from: 26000, to: 25000 } },
        },
      },
    ]);
    expect(await updateSegmentRule(database.pool, "gpu_3090", { floorCents: 60000 }, { at: AT, actor: "system:cli", action: "rules.set" }).catch((error: unknown) => error)).toMatchObject({ code: "23514" });
    expect(await auditRows()).toHaveLength(1);
  });
});

describe("updateFeed", () => {
  it("resumes a feed with an audit_event, and returns null for an unknown feed without writing", async () => {
    await database.pool.query("TRUNCATE app.audit_event");
    const audit = { at: AT, actor: "system:cli", action: "feeds.resume" };

    const feed = await updateFeed(database.pool, "ram", { enabled: true }, audit);
    const unknown = await updateFeed(database.pool, "tv" as FeedId, { enabled: true }, audit);

    expect(feed).toEqual({ ...startingFeed("ram"), enabled: true });
    expect(unknown).toBeNull();
    expect(await auditRows()).toEqual([
      { at: AT, actor: "system:cli", action: "feeds.resume", detail: { feed: "ram", changes: { enabled: { from: false, to: true } } } },
    ]);
    expect((await listFeeds(database.pool)).filter((f) => f.enabled).map((f) => f.id)).toEqual(["ram"]);
  });
});
