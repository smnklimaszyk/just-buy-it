// Synthetic Browse responses for tests in this package. Not built, not exported.
// Item ids come from the fake range v1|9000000000NN|0 (ADR 0023), so they never match a real listing.

let nextItem = 0;

export function buildItemSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  nextItem = (nextItem % 99) + 1;
  const nn = String(nextItem).padStart(2, "0");
  return {
    itemId: `v1|9000000000${nn}|0`,
    legacyItemId: `9000000000${nn}`,
    title: `Synthetic item ${nn}`,
    currentBidPrice: { value: "12.50", currency: "EUR" },
    buyingOptions: ["AUCTION"],
    leafCategoryIds: ["19006"],
    categories: [{ categoryId: "19006", categoryName: "LEGO" }],
    condition: "Neu",
    conditionId: "1000",
    shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "4.99", currency: "EUR" } }],
    itemLocation: { country: "DE" },
    seller: { feedbackPercentage: "99.8", feedbackScore: 1234, sellerAccountType: "INDIVIDUAL" },
    itemCreationDate: "2026-10-18T09:00:00.000Z",
    itemEndDate: "2026-10-25T09:00:00.000Z",
    itemWebUrl: `https://www.ebay.de/itm/9000000000${nn}`,
    image: { imageUrl: `https://i.ebayimg.com/images/g/synthetic${nn}/s-l225.jpg` },
    bidCount: 3,
    ...overrides,
  };
}

export function buildSearchPage(
  items: unknown[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    href: "https://api.ebay.com/buy/browse/v1/item_summary/search?q=synthetic&limit=50&offset=0",
    total: items.length,
    limit: 50,
    offset: 0,
    itemSummaries: items,
    ...overrides,
  };
}
