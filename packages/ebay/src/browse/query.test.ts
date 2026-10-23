import { describe, expect, it } from "vitest";
import {
  buildCategorySearch,
  buildFeedSearch,
  buildMarketSearch,
  endUserContext,
  type FeedSearchInput,
  type MarketSearchInput,
} from "./query.js";

const gpuPoll: FeedSearchInput = {
  q: "(3090,4090,rtx3090,rtx4090)",
  categoryId: "27386",
  conditionIds: ["1500", "2500", "3000"],
  price: { floorEur: 260, ceilingEur: 2400 },
  sort: "newlyListed",
  postalCode: "80331",
};

describe("endUserContext", () => {
  it("gives the exact X-EBAY-C-ENDUSERCTX value for a postal code", () => {
    expect(endUserContext("80331")).toBe("contextualLocation=country%3DDE%2Czip%3D80331");
  });

  it.each(["8033", "803311", "80 331", "80331,x", ""])("rejects the postal code %j", (postalCode) => {
    expect(() => endUserContext(postalCode)).toThrow(RangeError);
  });
});

describe("buildFeedSearch", () => {
  it("builds the poll request of section 3.2 with the exact filter string", () => {
    const request = buildFeedSearch(gpuPoll);

    expect(request).toEqual({
      q: "(3090,4090,rtx3090,rtx4090)",
      categoryIds: ["27386"],
      filter: [
        "buyingOptions:{FIXED_PRICE|BEST_OFFER}",
        "conditionIds:{1500|2500|3000}",
        "deliveryCountry:DE",
        "itemLocationCountry:DE",
        "price:[260..2400]",
        "priceCurrency:EUR",
      ],
      sort: "newlyListed",
      limit: 200,
      endUserContext: "contextualLocation=country%3DDE%2Czip%3D80331",
    });
    expect(request.filter?.join(",")).toBe(
      "buyingOptions:{FIXED_PRICE|BEST_OFFER},conditionIds:{1500|2500|3000},deliveryCountry:DE," +
        "itemLocationCountry:DE,price:[260..2400],priceCurrency:EUR",
    );
  });

  it("accepts a q of exactly 100 characters and rejects one of 101", () => {
    const terms = (length: number) => `(${"a".repeat(length - 4)},b)`;

    expect(terms(100)).toHaveLength(100);
    expect(buildFeedSearch({ ...gpuPoll, q: terms(100) }).q).toBe(terms(100));
    expect(() => buildFeedSearch({ ...gpuPoll, q: terms(101) })).toThrow(RangeError);
  });

  it.each([
    ["an empty q", ""],
    ["a space", "rtx 3090"],
    ["a filter brace", "{3090}"],
    ["a pipe", "3090|4090"],
    ["a colon", "price:1"],
    ["a quote", '"3090"'],
    ["an exclusion", "3090 -defekt"],
    ["a wildcard", "309*"],
    ["an ampersand", "3090&4090"],
    ["a percent sign", "3090%2C"],
    ["an empty OR term", "(3090,,4090)"],
    ["an OR group with one term", "(3090)"],
    ["an unclosed OR group", "(3090,4090"],
    ["a nested OR group", "((3090,4090),rtx)"],
  ])("rejects %s in q", (_name, q) => {
    expect(() => buildFeedSearch({ ...gpuPoll, q })).toThrow(RangeError);
  });

  it("rejects a category ID that is not a number", () => {
    expect(() => buildFeedSearch({ ...gpuPoll, categoryId: "27386,179" })).toThrow(RangeError);
    expect(() => buildFeedSearch({ ...gpuPoll, categoryId: "" })).toThrow(RangeError);
  });

  it("rejects an empty condition list and a condition ID that is not a number", () => {
    expect(() => buildFeedSearch({ ...gpuPoll, conditionIds: [] })).toThrow(RangeError);
    expect(() => buildFeedSearch({ ...gpuPoll, conditionIds: ["3000|7000"] })).toThrow(RangeError);
  });

  it("rejects a price filter that is not whole euros from 0 with floor at most ceiling", () => {
    const withPrice = (floorEur: number, ceilingEur: number) => () =>
      buildFeedSearch({ ...gpuPoll, price: { floorEur, ceilingEur } });

    expect(withPrice(500, 400)).toThrow(RangeError);
    expect(withPrice(260.5, 2400)).toThrow(RangeError);
    expect(withPrice(-1, 2400)).toThrow(RangeError);
    expect(withPrice(260, Number.NaN)).toThrow(RangeError);
    expect(withPrice(400, 400)()).toMatchObject({ filter: expect.arrayContaining(["price:[400..400]"]) });
  });

  it("passes a whole offset from 0 for overflow pages and rejects any other", () => {
    expect(buildFeedSearch({ ...gpuPoll, offset: 200 }).offset).toBe(200);
    expect(() => buildFeedSearch({ ...gpuPoll, offset: -200 })).toThrow(RangeError);
    expect(() => buildFeedSearch({ ...gpuPoll, offset: 1.5 })).toThrow(RangeError);
  });

  it("builds a sweep with sort=price, a single term and the segment's band", () => {
    const request = buildFeedSearch({
      ...gpuPoll,
      q: "ddr4",
      categoryId: "170083",
      price: { floorEur: 51, ceilingEur: 204 },
      sort: "price",
    });

    expect(request).toMatchObject({ q: "ddr4", categoryIds: ["170083"], sort: "price", limit: 200 });
    expect(request.filter).toContain("price:[51..204]");
    expect(request.filter?.filter((f) => f.startsWith("itemLocation"))).toEqual(["itemLocationCountry:DE"]);
  });

  it("does not put the rejected q into the error message", () => {
    expect(() => buildFeedSearch({ ...gpuPoll, q: "q-sentinel|x" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("q-sentinel") }),
    );
  });
});

const lensSnapshot: MarketSearchInput = {
  q: "(85mm,portraitobjektiv)",
  categoryId: "3323",
  conditionIds: ["2750", "3000"],
  postalCode: "80331",
};

describe("buildMarketSearch", () => {
  it("builds the snapshot of spec 6.3: fixed price or Best Offer, DE, EUR, no price filter, newest first", () => {
    const request = buildMarketSearch(lensSnapshot);

    expect(request).toEqual({
      q: "(85mm,portraitobjektiv)",
      categoryIds: ["3323"],
      filter: [
        "buyingOptions:{FIXED_PRICE|BEST_OFFER}",
        "conditionIds:{2750|3000}",
        "deliveryCountry:DE",
        "itemLocationCountry:DE",
        "priceCurrency:EUR",
      ],
      sort: "newlyListed",
      limit: 200,
      endUserContext: "contextualLocation=country%3DDE%2Czip%3D80331",
    });
    expect(buildMarketSearch({ ...lensSnapshot, offset: 400 }).offset).toBe(400);
  });

  it("checks q, category, conditions, offset and postal code like the feed search", () => {
    expect(() => buildMarketSearch({ ...lensSnapshot, q: "85mm portrait" })).toThrow(RangeError);
    expect(() => buildMarketSearch({ ...lensSnapshot, q: `(${"a".repeat(98)},b)` })).toThrow(RangeError);
    expect(() => buildMarketSearch({ ...lensSnapshot, categoryId: "3323,179" })).toThrow(RangeError);
    expect(() => buildMarketSearch({ ...lensSnapshot, conditionIds: [] })).toThrow(RangeError);
    expect(() => buildMarketSearch({ ...lensSnapshot, offset: -1 })).toThrow(RangeError);
    expect(() => buildMarketSearch({ ...lensSnapshot, postalCode: "8033" })).toThrow(RangeError);
  });
});

describe("buildCategorySearch", () => {
  it("asks for the category refinements of the words: no category, one item, DE and EUR (spec 6.6)", () => {
    expect(buildCategorySearch({ q: "(rennrad,carbon)" })).toEqual({
      q: "(rennrad,carbon)",
      filter: ["buyingOptions:{FIXED_PRICE|BEST_OFFER}", "deliveryCountry:DE", "itemLocationCountry:DE", "priceCurrency:EUR"],
      limit: 1,
      fieldgroups: ["CATEGORY_REFINEMENTS"],
    });
    expect(() => buildCategorySearch({ q: "rennrad -carbon" })).toThrow(RangeError);
  });
});
