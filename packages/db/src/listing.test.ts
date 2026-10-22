import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { confirmListings, getListing, insertListing, markListingGone, upsertListingContent, type ListingContentInput } from "./listing.js";
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
const HOUR = 3600;
const key = (n: number) => n.toString(16).padStart(64, "0");

const listingInput = (n: number) => ({
  itemKey: key(n),
  keyVersion: 1,
  itemId: `v1|${100 + n}|0`,
  legacyItemId: `${100 + n}`,
  feedId: "gpu" as const,
  segment: "gpu_3090" as const,
  firstSeenAt: at(0),
  itemCreationAt: at(-600),
  itemEndAt: at(30 * 24 * HOUR),
  contentExpiresAt: at(6 * HOUR),
});

const summary: ListingContentInput = {
  source: "summary",
  title: "RTX 3090 Founders Edition",
  condition: "Used",
  conditionDescription: null,
  sellerFeedbackScore: 250,
  sellerFeedbackPct: 99.8,
  sellerAccountType: "private",
  returnsAccepted: null,
  returnsDays: null,
  itemLocationCountry: null,
  aspects: null,
  descriptionText: null,
  imageCount: null,
  fetchedAt: at(0),
  contentExpiresAt: at(6 * HOUR),
};

describe("insertListing, upsertListingContent and getListing", () => {
  it("stores the summary content, then replaces it with the getItem content and moves the expiry", async () => {
    const id = await insertListing(database.pool, listingInput(1));
    await upsertListingContent(database.pool, id, summary);
    const first = await getListing(database.pool, id);

    await upsertListingContent(database.pool, id, {
      ...summary,
      source: "item",
      conditionDescription: "Works fine",
      returnsAccepted: true,
      returnsDays: 30,
      itemLocationCountry: "DE",
      aspects: [{ name: "Chipsatz", value: "RTX 3090" }],
      descriptionText: "Card in good shape.",
      imageCount: 6,
      fetchedAt: at(300),
      contentExpiresAt: at(300 + 6 * HOUR),
    });
    const second = await getListing(database.pool, id);

    expect(first).toMatchObject({
      id,
      itemKey: key(1),
      legacyItemId: "101",
      segment: "gpu_3090",
      contentExpiresAt: at(6 * HOUR),
      goneAt: null,
      content: summary,
    });
    expect(second?.contentExpiresAt).toEqual(at(300 + 6 * HOUR));
    expect(second?.content).toMatchObject({ source: "item", imageCount: 6, aspects: [{ name: "Chipsatz", value: "RTX 3090" }] });
    expect(await getListing(database.pool, "00000000-0000-7000-8000-000000000000")).toBeNull();
  });
});

describe("confirmListings and markListingGone", () => {
  it("moves last_confirmed_at forward only, and marks a listing gone once with its reason", async () => {
    const id = await insertListing(database.pool, listingInput(2));

    await confirmListings(database.pool, [key(2), key(99)], at(600));
    await confirmListings(database.pool, [key(2)], at(300));
    const first = await markListingGone(database.pool, id, "not_found", at(700));
    const second = await markListingGone(database.pool, id, "ended", at(800));

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await getListing(database.pool, id)).toMatchObject({
      lastConfirmedAt: at(600),
      goneAt: at(700),
      goneReason: "not_found",
    });
  });
});
