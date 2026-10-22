import { describe, expect, it } from "vitest";
import {
  contentExpiresAt,
  isTooOldAtFirstSighting,
  parseAmountCents,
  toListingCandidate,
  type ItemSummaryInput,
} from "./listing.js";

const FETCHED_AT = new Date("2026-10-21T10:00:00Z");

function summary(extra: Partial<ItemSummaryInput> = {}): ItemSummaryInput {
  return {
    itemId: "v1|110000000001|0",
    legacyItemId: "110000000001",
    title: "NVIDIA RTX 3090 Founders Edition",
    price: { value: "459.00", currency: "EUR" },
    buyingOptions: ["FIXED_PRICE", "BEST_OFFER"],
    conditionId: "3000",
    condition: "Gebraucht",
    shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "30.00", currency: "EUR" } }],
    seller: { feedbackScore: 250, feedbackPercentage: "100.0", sellerAccountType: "INDIVIDUAL" },
    leafCategoryIds: ["27386"],
    itemCreationDate: "2026-10-21T09:00:00.000Z",
    itemEndDate: "2026-11-20T09:00:00.000Z",
    ...extra,
  };
}

describe("parseAmountCents", () => {
  it.each([
    ["559.99", 55999],
    ["559.9", 55990],
    ["559", 55900],
    ["0.01", 1],
    ["1200.00", 120000],
    ["", null],
    ["-5.00", null],
    ["5,00", null],
    ["5.001", null],
    ["1e3", null],
    [" 5.00", null],
  ])("reads %j as %j integer cents", (value, cents) => {
    expect(parseAmountCents(value)).toBe(cents);
  });
});

describe("toListingCandidate", () => {
  it("turns a summary into a listing with integer cents and the landed price", () => {
    expect(toListingCandidate(summary(), FETCHED_AT)).toEqual({
      ok: true,
      listing: {
        itemId: "v1|110000000001|0",
        legacyItemId: "110000000001",
        title: "NVIDIA RTX 3090 Founders Edition",
        priceCents: 45900,
        shippingCents: 3000,
        landedCents: 48900,
        shippingKnown: true,
        buyingOptions: ["FIXED_PRICE", "BEST_OFFER"],
        itemGroup: false,
        conditionId: "3000",
        conditionText: "Gebraucht",
        seller: { feedbackScore: 250, feedbackPercent: 100, accountType: "private" },
        categoryIds: ["27386"],
        itemCreationAt: new Date("2026-10-21T09:00:00.000Z"),
        itemEndAt: new Date("2026-11-20T09:00:00.000Z"),
        fetchedAt: FETCHED_AT,
        contentExpiresAt: new Date("2026-10-21T16:00:00Z"),
      },
    });
  });

  it.each([
    ["a price in another currency", { price: { value: "459.00", currency: "USD" } }, "not_eur"],
    ["no price", { price: undefined }, "malformed"],
    ["a price that is not a decimal", { price: { value: "459,00", currency: "EUR" } }, "malformed"],
    ["no legacy item ID", { legacyItemId: undefined }, "malformed"],
  ])("rejects a summary with %s", (_name, extra, reason) => {
    expect(toListingCandidate(summary(extra), FETCHED_AT)).toEqual({ ok: false, reason });
  });

  it.each([
    ["no shipping options", { shippingOptions: undefined }, null],
    ["an option without a cost", { shippingOptions: [{ shippingCostType: "FIXED" }] }, null],
    [
      "a calculated cost",
      { shippingOptions: [{ shippingCostType: "CALCULATED", shippingCost: { value: "5.00", currency: "EUR" } }] },
      null,
    ],
    [
      "a cost in another currency",
      { shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "5.00", currency: "USD" } }] },
      null,
    ],
    [
      "free shipping",
      { shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "0.00", currency: "EUR" } }] },
      0,
    ],
    [
      "two fixed options",
      {
        shippingOptions: [
          { shippingCostType: "FIXED", shippingCost: { value: "12.00", currency: "EUR" } },
          { shippingCostType: "FIXED", shippingCost: { value: "6.99", currency: "EUR" } },
        ],
      },
      699,
    ],
  ])("reads shipping from %s, and unknown shipping is never zero", (_name, extra, shippingCents) => {
    const result = toListingCandidate(summary(extra), FETCHED_AT);
    if (!result.ok) throw new Error("expected a listing");
    expect(result.listing.shippingCents).toBe(shippingCents);
    expect(result.listing.shippingKnown).toBe(shippingCents !== null);
    expect(result.listing.landedCents).toBe(shippingCents === null ? null : 45900 + shippingCents);
    expect(result.listing.priceCents).toBe(45900);
  });
});

describe("contentExpiresAt", () => {
  it.each([
    ["6 hours after the fetch", "2026-11-20T09:00:00Z", "2026-10-21T16:00:00.000Z"],
    ["at the item end when that is sooner", "2026-10-21T12:30:00Z", "2026-10-21T12:30:00.000Z"],
    ["6 hours after the fetch without an end date", null, "2026-10-21T16:00:00.000Z"],
  ])("is %s", (_name, end, expected) => {
    expect(contentExpiresAt(FETCHED_AT, end === null ? null : new Date(end)).toISOString()).toBe(expected);
  });
});

describe("age limit at the first sighting", () => {
  it.each([
    ["created an hour ago", "2026-10-21T09:00:00Z", false],
    ["exactly 24 hours old", "2026-10-20T10:00:00Z", false],
    ["24 hours and 1 second old", "2026-10-20T09:59:59Z", true],
    ["a week old", "2026-10-14T10:00:00Z", true],
    ["without a creation date", null, false],
  ])("an item %s is too old: %s", (_name, created, tooOld) => {
    expect(isTooOldAtFirstSighting(created === null ? null : new Date(created), FETCHED_AT)).toBe(tooOld);
  });
});
