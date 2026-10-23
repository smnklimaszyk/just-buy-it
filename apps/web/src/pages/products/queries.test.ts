import { afterAll, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../testing/harness.js";
import { currentMarketValues, filteredCounts, filteredTitles, newestListings, productActivity, productRevisions } from "./queries.js";
import { itemKey, seedAlert, seedCandidate, seedMarketValue, seedProduct } from "./testing/products.js";

// The product pages' own reads, as role web.

let h: Harness | undefined;

vi.setConfig({ testTimeout: 30_000 });

const harness = async (): Promise<Harness> => (h ??= await createHarness());

afterAll(async () => {
  await h?.db.drop();
});

const HOUR = 3_600_000;

describe("productActivity", () => {
  it("counts each product's candidates of the Berlin day and finds its newest alert", async () => {
    const hh = await harness();
    const lens = await seedProduct(hh);
    const bike = await seedProduct(hh, { name: "Road bike", searchWords: ["rennrad"], mustWords: [["rennrad"]] });
    const now = hh.clock.now();
    await seedCandidate(hh, lens, { decision: "pending", createdAt: now });
    const alerted = await seedCandidate(hh, lens, { decision: "alerted", createdAt: new Date(now.getTime() - 3 * HOUR) });
    // 12:00 Berlin minus 13 h is yesterday.
    await seedCandidate(hh, lens, { decision: "alerted", createdAt: new Date(now.getTime() - 13 * HOUR) });
    await seedAlert(hh, lens, alerted, new Date(now.getTime() - 3 * HOUR));

    const activity = await productActivity(hh.db.pool, now);

    expect(activity.get(lens.key)).toEqual({ candidatesToday: 2, lastDealAt: new Date(now.getTime() - 3 * HOUR) });
    expect(activity.get(bike.key)).toBeUndefined();
  });
});

describe("currentMarketValues", () => {
  it("gives per product the newest value of each group of its match version, and the newest ok one for the limit", async () => {
    const hh = await harness();
    const product = await seedProduct(hh, { name: "Espresso machine", searchWords: ["siebträger"], mustWords: [["siebträger"]] });
    const now = hh.clock.now();
    const before = (hours: number) => new Date(now.getTime() - hours * HOUR);
    const ok = await seedMarketValue(hh, product, { group: "used", status: "ok", valueCents: 30_000, computedAt: before(30) });
    const rough = await seedMarketValue(hh, product, { group: "used", status: "rough", valueCents: 31_000, computedAt: before(5) });
    await seedMarketValue(hh, product, { group: "used", status: "ok", valueCents: 99_000, computedAt: before(1), matchVersion: product.matchVersion + 1 });
    await seedMarketValue(hh, product, { group: "used", status: "ok", valueCents: 99_000, computedAt: new Date(now.getTime() + HOUR) });

    const values = (await currentMarketValues(hh.db.pool, now)).get(product.id);

    expect(values?.newest.map((value) => [value.id, value.status, value.valueCents])).toEqual([[rough, "rough", 31_000]]);
    expect(values?.ok.map((value) => [value.id, value.conditionGroup, value.valueCents])).toEqual([[ok, "used", 30_000]]);
  });
});

describe("newestListings", () => {
  it("reads the titles of the newest check of the last 6 hours, cheapest first", async () => {
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "Listings lens" });
    const bike = await seedProduct(hh, { name: "Listings bike", searchWords: ["rennrad"], mustWords: [["rennrad"]] });
    const now = hh.clock.now();
    const insert = (productId: string, id: string, landed: number, outcome: string, seenAt: Date) =>
      hh.db.admin.query(
        `INSERT INTO ebay_live.market_preview (product_id, item_key, legacy_item_id, title, landed_cents, condition_group, outcome, seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [productId, `k-${id}`, id, `Title ${id}`, landed, outcome === "match" ? "used" : null, outcome, seenAt],
      );
    await insert(lens.id, "201", 50_000, "match", new Date(now.getTime() - HOUR));
    await insert(lens.id, "202", 30_000, "accessory", new Date(now.getTime() - HOUR));
    await insert(bike.id, "203", 10_000, "match", new Date(now.getTime() - HOUR));
    const old = await seedProduct(hh, { name: "Listings old" });
    await insert(old.id, "204", 10_000, "match", new Date(now.getTime() - 7 * HOUR));

    const [listings, none] = await Promise.all([newestListings(hh.db.pool, lens.id, now), newestListings(hh.db.pool, old.id, now)]);

    expect(listings).toEqual([
      { legacyItemId: "202", title: "Title 202", landedCents: 30_000, conditionGroup: null, outcome: "accessory" },
      { legacyItemId: "201", title: "Title 201", landedCents: 50_000, conditionGroup: "used", outcome: "match" },
    ]);
    expect(none).toEqual([]);
  });
});

describe("filteredCounts", () => {
  it("counts a product key's filtered listings per outcome for 24 hours and 7 days, most first", async () => {
    const hh = await harness();
    const now = hh.clock.now();
    const seen = (segment: string, outcome: string, hoursAgo: number) =>
      hh.db.admin.query(
        "INSERT INTO app.seen_item (item_key, key_version, feed_id, segment, outcome, first_seen_at, last_seen_at) VALUES ($1, 1, 's1', $2, $3, $4, $4)",
        [itemKey(), segment, outcome, new Date(now.getTime() - hoursAgo * HOUR)],
      );
    await seen("p_counts", "accessory", 1);
    await seen("p_counts", "accessory", 30);
    await seen("p_counts", "excluded_word", 2);
    await seen("p_counts", "excluded_word", 3);
    await seen("p_counts", "defective", 100);
    await seen("p_counts", "defective", 200);
    await seen("p_counts", "candidate", 1);
    await seen("p_elsewhere", "accessory", 1);

    expect(await filteredCounts(hh.db.pool, "p_counts", now)).toEqual([
      { outcome: "excluded_word", day: 2, week: 2 },
      { outcome: "accessory", day: 1, week: 2 },
      { outcome: "defective", day: 0, week: 1 },
    ]);
  });
});

describe("productRevisions", () => {
  it("reads a product's revisions newest first, with the email of the person behind a user actor", async () => {
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "Revision lens", categoryId: "3329", status: "draft" });
    await hh.db.admin.query("INSERT INTO auth.app_user (email, role) VALUES ('rita@example.test', 'editor')");
    const rita = await hh.db.admin.query<{ id: string }>("SELECT id FROM auth.app_user WHERE email = 'rita@example.test'");
    const at = new Date(hh.clock.now().getTime() + HOUR);
    await hh.db.admin.query("INSERT INTO app.product_revision (product_id, version, rules, actor, created_at) VALUES ($1, 2, $2, $3, $4)", [
      lens.id,
      JSON.stringify({ name: "Renamed" }),
      `user:${rita.rows[0]?.id ?? ""}`,
      at,
    ]);

    const revisions = await productRevisions(hh.db.pool, lens.id);

    expect(revisions.map((r) => [r.version, r.actor, r.email, r.createdAt])).toEqual([
      [2, `user:${rita.rows[0]?.id ?? ""}`, "rita@example.test", at],
      [1, "system:cli", null, hh.clock.now()],
    ]);
    expect(revisions[0]?.rules).toEqual({ name: "Renamed" });
  });
});

describe("filteredTitles", () => {
  it("reads a product key's rejected titles of the last 6 hours, newest first", async () => {
    const hh = await harness();
    const now = hh.clock.now();
    const sample = (segment: string, title: string, outcome: string, hoursAgo: number) => {
      const at = new Date(now.getTime() - hoursAgo * HOUR);
      return hh.db.admin.query(
        `INSERT INTO ebay_live.classifier_sample (feed_id, segment, title, landed_cents, outcome, reason, seen_at, expires_at)
         VALUES ('s1', $1, $2, 2000, $3, $4, $5, $5::timestamptz + interval '6 hours')`,
        [segment, title, outcome, outcome === "rejected" ? "accessory" : null, at],
      );
    };
    await sample("p_titles", "Older", "rejected", 2);
    await sample("p_titles", "Newer", "rejected", 1);
    await sample("p_titles", "Accepted", "candidate", 1);
    await sample("p_titles", "Too old", "rejected", 7);
    await sample("p_elsewhere", "Elsewhere", "rejected", 1);

    expect(await filteredTitles(hh.db.pool, "p_titles", now)).toEqual([
      { title: "Newer", landedCents: 2000, reason: "accessory", seenAt: new Date(now.getTime() - HOUR) },
      { title: "Older", landedCents: 2000, reason: "accessory", seenAt: new Date(now.getTime() - 2 * HOUR) },
    ]);
  });
});
