import { describe, expect, it } from "vitest";
import { buildItem, buildItemSummary, buildSearchPage } from "../testing/browse.js";
import { itemSchema, itemSummarySchema, searchPageSchema } from "./schemas.js";

describe("Browse schemas and the synthetic builders", () => {
  it("parse the builders' output without losing a declared field", () => {
    const item = buildItemSummary();
    const page = buildSearchPage([item]);

    expect(itemSummarySchema.parse(item)).toEqual(item);
    expect(searchPageSchema.parse(page)).toEqual({ total: 1, limit: 50, offset: 0, itemSummaries: [item] });
  });

  it("give every item an id from the fake range v1|9000000000NN|0 (ADR 0023)", () => {
    const ids = Array.from({ length: 150 }, () => buildItemSummary().itemId);

    for (const id of ids) expect(id).toMatch(/^v1\|9000000000\d{2}\|0$/);
    expect(new Set(ids.slice(0, 99)).size).toBe(99);
  });

  it("keep itemOriginDate, the date a relisted item first went up (spec 6.2)", () => {
    const item = buildItemSummary({ itemOriginDate: "2026-09-30T08:00:00.000Z" });

    expect(itemSummarySchema.parse(item).itemOriginDate).toBe("2026-09-30T08:00:00.000Z");
    expect(itemSummarySchema.safeParse({ ...item, itemOriginDate: "yesterday" }).success).toBe(false);
  });

  it("keep the category refinements with id, name and match count, and drop their links (spec 6.6)", () => {
    const page = buildSearchPage([], {
      refinement: {
        dominantCategoryId: "177831",
        categoryDistributions: [
          { categoryId: "177831", categoryName: "Rennräder", matchCount: 412, refinementHref: "https://api.ebay.com/x" },
          { categoryId: "177837" },
        ],
      },
    });

    expect(searchPageSchema.parse(page).refinement).toEqual({
      categoryDistributions: [{ categoryId: "177831", categoryName: "Rennräder", matchCount: 412 }, { categoryId: "177837" }],
    });
  });

  it("parse the getItem builder's output without losing a declared field", () => {
    const item = buildItem();

    expect(itemSchema.parse(item)).toEqual(item);
  });

  it("drop seller.username, seller.userId, sellerLegalInfo and responsiblePersons from getItem (A23)", () => {
    const item = buildItem();
    const withIdentity = {
      ...item,
      seller: { ...(item.seller as object), username: "SENTINEL_SELLER_7f3a", userId: "SENTINEL_SELLER_7f3a" },
      sellerLegalInfo: { legalContactFirstName: "SENTINEL_SELLER_7f3a", email: "sentinel@example.invalid" },
      responsiblePersons: [{ companyName: "SENTINEL_SELLER_7f3a", email: "sentinel@example.invalid" }],
      itemLocation: { country: "DE", postalCode: "SENTINEL_POSTAL", city: "SENTINEL_CITY" },
    };

    const parsed = itemSchema.parse(withIdentity);

    expect(parsed).toEqual(item);
    expect(JSON.stringify(parsed)).not.toMatch(/SENTINEL|sentinel/);
  });
});
