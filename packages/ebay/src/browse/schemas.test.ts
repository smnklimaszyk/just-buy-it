import { describe, expect, it } from "vitest";
import { buildItemSummary, buildSearchPage } from "../testing/browse.js";
import { itemSummarySchema, searchPageSchema } from "./schemas.js";

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
});
