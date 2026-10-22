import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  countCandidatesSince,
  countScreensInFlight,
  getCandidateByListingId,
  insertCandidate,
  listingsToEnrich,
  listingsToScreen,
  markEnrichStarted,
  setCandidateDecision,
  updateCandidateAfterEnrich,
  type CandidateInput,
} from "./candidate.js";
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
const listingId = (n: number) => `00000000-0000-7000-8000-${n.toString().padStart(12, "0")}`;

const candidateInput = (n: number, createdAt: Date): CandidateInput => ({
  itemKey: key(n),
  listingId: listingId(n),
  feedId: "gpu",
  segment: "gpu_3090",
  source: "poll",
  priceCents: 45900,
  shippingCents: 3000,
  landedCents: 48900,
  shippingKnown: true,
  totalGb: null,
  ruleVersion: 3,
  flags: ["mining_history", "best_offer"],
  createdAt,
});

describe("insertCandidate, getCandidateByListingId and countCandidatesSince", () => {
  it("stores one candidate per item, finds it by listing and counts a segment's candidates since a time", async () => {
    const id = await insertCandidate(database.pool, candidateInput(1, at(0)));
    await insertCandidate(database.pool, candidateInput(2, at(60)));
    await insertCandidate(database.pool, { ...candidateInput(3, at(60)), segment: "gpu_4090" });

    expect(await getCandidateByListingId(database.pool, listingId(1))).toEqual({
      id,
      ...candidateInput(1, at(0)),
      decision: "pending",
      rejectReason: null,
      enrichStartedAt: null,
      codeSignals: [],
    });
    expect(await getCandidateByListingId(database.pool, listingId(9))).toBeNull();
    expect(await countCandidatesSince(database.pool, "gpu_3090", at(0))).toBe(2);
    expect(await countCandidatesSince(database.pool, "gpu_3090", at(1))).toBe(1);
    await expect(insertCandidate(database.pool, { ...candidateInput(1, at(90)), listingId: listingId(8) })).rejects.toMatchObject({
      code: "23505",
    });
  });
});

describe("enrich writes", () => {
  it("marks enrich started once, updates prices and flags, and sets the decision only while pending", async () => {
    const id = await insertCandidate(database.pool, candidateInput(20, at(0)));

    expect(await markEnrichStarted(database.pool, id, at(10))).toBe(true);
    expect(await markEnrichStarted(database.pool, id, at(20))).toBe(false);
    await updateCandidateAfterEnrich(database.pool, id, {
      priceCents: 44900,
      shippingCents: null,
      landedCents: null,
      shippingKnown: false,
      flags: ["shipping_unknown"],
      codeSignals: ["iban_present", "payment_mention"],
    });
    expect(await setCandidateDecision(database.pool, id, { decision: "rejected_after_enrich", rejectReason: "defective" })).toBe(true);
    expect(await setCandidateDecision(database.pool, id, { decision: "alerted", rejectReason: null })).toBe(false);

    const expired = await insertCandidate(database.pool, candidateInput(21, at(0)));
    expect(await setCandidateDecision(database.pool, expired, { decision: "expired", rejectReason: null })).toBe(true);
    expect(await getCandidateByListingId(database.pool, listingId(21))).toMatchObject({ decision: "expired" });

    expect(await getCandidateByListingId(database.pool, listingId(20))).toMatchObject({
      enrichStartedAt: at(10),
      priceCents: 44900,
      shippingCents: null,
      landedCents: null,
      shippingKnown: false,
      flags: ["shipping_unknown"],
      codeSignals: ["iban_present", "payment_mention"],
      decision: "rejected_after_enrich",
      rejectReason: "defective",
    });
  });
});

describe("relay queries", () => {
  it("find lost enrich jobs and lost screen jobs after 10 minutes, never a getItem that ran or a finished screening", async () => {
    await database.pool.query("TRUNCATE app.candidate, app.screening");
    const listing = async (n: number, source: "summary" | "item") => {
      const result = await database.pool.query<{ id: string }>(
        `INSERT INTO ebay_live.listing (item_key, key_version, item_id, legacy_item_id, feed_id, segment, first_seen_at,
           last_confirmed_at, content_expires_at)
         VALUES ($1, 1, 'v1|1|0', '1', 'gpu', 'gpu_3090', $2, $2, $3) RETURNING id`,
        [key(n), at(0), at(21600)],
      );
      const id = result.rows[0]?.id ?? "";
      await database.pool.query(
        `INSERT INTO ebay_live.listing_content (listing_id, source, title, fetched_at, content_expires_at)
         VALUES ($1, $2, 't', $3, $4)`,
        [id, source, at(0), at(21600)],
      );
      return id;
    };
    const candidate = async (n: number, source: "summary" | "item", enrichStartedAt: Date | null) => {
      const id = await listing(n, source);
      const candidateId = await insertCandidate(database.pool, { ...candidateInput(n, at(0)), listingId: id });
      if (enrichStartedAt !== null) await markEnrichStarted(database.pool, candidateId, enrichStartedAt);
      return id;
    };
    const lostEnrich = await candidate(30, "summary", null);
    const lostAfterStart = await candidate(31, "summary", at(60));
    const lostScreen = await candidate(32, "item", at(0));
    const screened = await candidate(33, "item", at(0));
    const fresh = await candidate(34, "item", at(500));
    await database.pool.query(
      "INSERT INTO app.screening (item_key, prompt_version, model, status, verdict) VALUES ($1, 'screen-v1:abc', 'm', 'done', 'pass')",
      [key(33)],
    );

    expect(await listingsToEnrich(database.pool, at(599), 10)).toEqual([]);
    expect(await listingsToEnrich(database.pool, at(600), 10)).toEqual([lostEnrich]);
    // Enrich started 10 minutes ago and wrote no getItem content: the job died after the flag.
    // Enrich finishes it from the summary without a second getItem.
    expect((await listingsToEnrich(database.pool, at(660), 10)).sort()).toEqual([lostEnrich, lostAfterStart].sort());
    // Enriched or enriching candidates without a screening at the prompt version: 31, 32 and 34.
    expect(await countScreensInFlight(database.pool, "screen-v1:abc")).toBe(3);
    expect(await countScreensInFlight(database.pool, "screen-v1:new")).toBe(4);
    expect(await listingsToScreen(database.pool, "screen-v1:abc", at(1000), 10)).toEqual([lostScreen]);
    expect((await listingsToScreen(database.pool, "screen-v1:new", at(1100), 10)).sort()).toEqual([lostScreen, screened, fresh].sort());
  });
});
