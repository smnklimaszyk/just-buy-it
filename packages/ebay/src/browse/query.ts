import type { BrowseSearchRequest } from "./search.js";

// The one builder for Browse feed searches (ADR 0016, MVP spec section 3.2).

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

// Single-word terms only: one word, or an OR group of two or more words, "(3090,rtx3090)". Every
// other character (space, exclusion "-", quotes, filter syntax, wildcards) is refused.
const SINGLE_TERM = /^[\p{L}\p{N}]+$/u;
const OR_GROUP = /^\([\p{L}\p{N}]+(?:,[\p{L}\p{N}]+)+\)$/u;
const DIGITS = /^[0-9]+$/;

const isWholeFromZero = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

export function buildFeedSearch(input: FeedSearchInput): BrowseSearchRequest {
  if (input.q.length > MAX_Q_LENGTH) throw new RangeError(`q must be at most ${MAX_Q_LENGTH} characters`);
  // The message never carries the value.
  if (!SINGLE_TERM.test(input.q) && !OR_GROUP.test(input.q)) {
    throw new RangeError("q must be one word or an OR group of single words");
  }
  if (!DIGITS.test(input.categoryId)) throw new RangeError("category ID must be digits");
  if (input.conditionIds.length === 0 || !input.conditionIds.every((id) => DIGITS.test(id))) {
    throw new RangeError("condition IDs must be one or more IDs of digits");
  }
  const { floorEur, ceilingEur } = input.price;
  if (!isWholeFromZero(floorEur) || !isWholeFromZero(ceilingEur) || floorEur > ceilingEur) {
    throw new RangeError("price filter must be whole euros from 0, floor at most ceiling");
  }
  if (input.offset !== undefined && !isWholeFromZero(input.offset)) {
    throw new RangeError("offset must be a whole number from 0");
  }
  const filter = [
    "buyingOptions:{FIXED_PRICE|BEST_OFFER}",
    `conditionIds:{${input.conditionIds.join("|")}}`,
    "deliveryCountry:DE",
    // Never together with itemLocationRegion: both give error 12517.
    "itemLocationCountry:DE",
    `price:[${floorEur}..${ceilingEur}]`,
    "priceCurrency:EUR",
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

// The exact X-EBAY-C-ENDUSERCTX value: shipping costs and estimates are for this German postal code.
export function endUserContext(postalCode: string): string {
  if (!/^\d{5}$/.test(postalCode)) throw new RangeError("postal code must be 5 digits");
  return `contextualLocation=${encodeURIComponent(`country=DE,zip=${postalCode}`)}`;
}
