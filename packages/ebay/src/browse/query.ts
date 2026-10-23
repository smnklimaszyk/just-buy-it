import type { BrowseSearchRequest } from "./search.js";

// The builders for Browse searches (ADR 0016, MVP spec section 3.2, v2 spec 6.3 and 6.6).

export const FEED_PAGE_LIMIT = 200;

export type FeedSearchInput = {
  q: string;
  categoryId: string;
  conditionIds: readonly string[];
  // Whole euros.
  price: { floorEur: number; ceilingEur: number };
  // Poll: newlyListed. Sweep: price (lowest first).
  sort: "newlyListed" | "price";
  offset?: number;
  postalCode: string;
};

// eBay cuts q at 100 characters without an error (ADR 0016), so a longer q is refused here.
export const MAX_Q_LENGTH = 100;

// Single-word terms only: one word, or an OR group of two or more words, "(canon,nikon)". Every
// other character (space, exclusion "-", quotes, filter syntax, wildcards) is refused.
const SINGLE_TERM = /^[\p{L}\p{N}]+$/u;
const OR_GROUP = /^\([\p{L}\p{N}]+(?:,[\p{L}\p{N}]+)+\)$/u;
const DIGITS = /^[0-9]+$/;

const FIXED_PRICE = "buyingOptions:{FIXED_PRICE|BEST_OFFER}";
// Never together with itemLocationRegion: both give error 12517.
const IN_GERMANY = ["deliveryCountry:DE", "itemLocationCountry:DE"];
const IN_EUR = "priceCurrency:EUR";

const isWholeFromZero = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

// The messages never carry the value.
function checkQ(q: string): void {
  if (q.length > MAX_Q_LENGTH) throw new RangeError(`q must be at most ${MAX_Q_LENGTH} characters`);
  if (!SINGLE_TERM.test(q) && !OR_GROUP.test(q)) {
    throw new RangeError("q must be one word or an OR group of single words");
  }
}

function checkCategoryAndConditions(categoryId: string, conditionIds: readonly string[]): void {
  if (!DIGITS.test(categoryId)) throw new RangeError("category ID must be digits");
  if (conditionIds.length === 0 || !conditionIds.every((id) => DIGITS.test(id))) {
    throw new RangeError("condition IDs must be one or more IDs of digits");
  }
}

function checkOffset(offset: number | undefined): void {
  if (offset !== undefined && !isWholeFromZero(offset)) {
    throw new RangeError("offset must be a whole number from 0");
  }
}

export function buildFeedSearch(input: FeedSearchInput): BrowseSearchRequest {
  checkQ(input.q);
  checkCategoryAndConditions(input.categoryId, input.conditionIds);
  const { floorEur, ceilingEur } = input.price;
  if (!isWholeFromZero(floorEur) || !isWholeFromZero(ceilingEur) || floorEur > ceilingEur) {
    throw new RangeError("price filter must be whole euros from 0, floor at most ceiling");
  }
  checkOffset(input.offset);
  const filter = [
    FIXED_PRICE,
    `conditionIds:{${input.conditionIds.join("|")}}`,
    ...IN_GERMANY,
    `price:[${floorEur}..${ceilingEur}]`,
    IN_EUR,
  ];
  return {
    q: input.q,
    categoryIds: [input.categoryId],
    filter,
    sort: input.sort,
    limit: FEED_PAGE_LIMIT,
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    endUserContext: endUserContext(input.postalCode),
  };
}

export type MarketSearchInput = {
  q: string;
  categoryId: string;
  conditionIds: readonly string[];
  offset?: number;
  postalCode: string;
};

// Spec 6.3: one page of a market snapshot. The product's words, category and conditions with no
// price filter, newest first, so a snapshot that stops early misses only the oldest asks.
export function buildMarketSearch(input: MarketSearchInput): BrowseSearchRequest {
  checkQ(input.q);
  checkCategoryAndConditions(input.categoryId, input.conditionIds);
  checkOffset(input.offset);
  return {
    q: input.q,
    categoryIds: [input.categoryId],
    filter: [FIXED_PRICE, `conditionIds:{${input.conditionIds.join("|")}}`, ...IN_GERMANY, IN_EUR],
    sort: "newlyListed",
    limit: FEED_PAGE_LIMIT,
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    endUserContext: endUserContext(input.postalCode),
  };
}

// Spec 6.6, "Suggest category": the categories eBay counts for the words among fixed-price asks in
// Germany. No category and one item: only the refinements are read.
export function buildCategorySearch(input: { q: string }): BrowseSearchRequest {
  checkQ(input.q);
  return { q: input.q, filter: [FIXED_PRICE, ...IN_GERMANY, IN_EUR], limit: 1, fieldgroups: ["CATEGORY_REFINEMENTS"] };
}

// The exact X-EBAY-C-ENDUSERCTX value: shipping costs and estimates are for this German postal code.
export function endUserContext(postalCode: string): string {
  if (!/^\d{5}$/.test(postalCode)) throw new RangeError("postal code must be 5 digits");
  return `contextualLocation=${encodeURIComponent(`country=DE,zip=${postalCode}`)}`;
}
