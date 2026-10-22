type Amount = { value: string; currency: string };

// The fields of a Browse item summary the domain reads. The eBay package's parsed ItemSummary fits
// this shape; the domain does not import it (ADR 0006).
export type ItemSummaryInput = {
  itemId: string;
  legacyItemId?: string | undefined;
  title?: string | undefined;
  price?: Amount | undefined;
  buyingOptions?: string[] | undefined;
  itemGroupType?: string | undefined;
  itemGroupHref?: string | undefined;
  leafCategoryIds?: string[] | undefined;
  categories?: { categoryId: string }[] | undefined;
  condition?: string | undefined;
  conditionId?: string | undefined;
  shippingOptions?: { shippingCostType?: string | undefined; shippingCost?: Amount | undefined }[] | undefined;
  seller?:
    | {
        feedbackPercentage?: string | undefined;
        feedbackScore?: number | undefined;
        sellerAccountType?: string | undefined;
      }
    | undefined;
  itemCreationDate?: string | undefined;
  itemEndDate?: string | undefined;
};

export type SellerAccountType = "business" | "private";

export type ListingCandidate = {
  itemId: string;
  legacyItemId: string;
  title: string;
  priceCents: number;
  // null when the summary gives no fixed shipping cost to DE. Unknown shipping is never zero.
  shippingCents: number | null;
  landedCents: number | null;
  shippingKnown: boolean;
  buyingOptions: string[];
  itemGroup: boolean;
  conditionId: string | null;
  conditionText: string | null;
  seller: { feedbackScore: number | null; feedbackPercent: number | null; accountType: SellerAccountType | null };
  categoryIds: string[];
  itemCreationAt: Date | null;
  itemEndAt: Date | null;
  fetchedAt: Date;
  contentExpiresAt: Date;
};

export type ListingResult = { ok: true; listing: ListingCandidate } | { ok: false; reason: "malformed" | "not_eur" };

const AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

// eBay amounts are decimal strings ("559.99"). Prices are kept as integer cents from here on.
export function parseAmountCents(value: string): number | null {
  const match = AMOUNT.exec(value);
  if (!match) return null;
  const euros = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  return euros * 100 + cents;
}

export const CONTENT_LIFETIME_MS = 6 * 60 * 60 * 1000;

// ADR 0014: listing content lives at most 6 hours after the fetch, and never past the item's end.
export function contentExpiresAt(fetchedAt: Date, itemEndAt: Date | null): Date {
  const sixHours = fetchedAt.getTime() + CONTENT_LIFETIME_MS;
  return new Date(itemEndAt === null ? sixHours : Math.min(sixHours, itemEndAt.getTime()));
}

export const MAX_FIRST_SIGHTING_AGE_MS = 24 * 60 * 60 * 1000;

// Section 3.2: an item first seen more than 24 hours after it was listed never becomes a
// candidate. Without a creation date the age is unknown and the item is not held back.
export function isTooOldAtFirstSighting(itemCreationAt: Date | null, now: Date): boolean {
  if (itemCreationAt === null) return false;
  return now.getTime() - itemCreationAt.getTime() > MAX_FIRST_SIGHTING_AGE_MS;
}

function shippingCentsToDe(item: ItemSummaryInput): number | null {
  let cheapest: number | null = null;
  for (const option of item.shippingOptions ?? []) {
    const cost = option.shippingCost;
    // A calculated cost depends on the buyer's address and is treated as unknown.
    if (!cost || cost.currency !== "EUR" || option.shippingCostType === "CALCULATED") continue;
    const cents = parseAmountCents(cost.value);
    if (cents !== null && (cheapest === null || cents < cheapest)) cheapest = cents;
  }
  return cheapest;
}

function accountType(value: string | undefined): SellerAccountType | null {
  if (value === "BUSINESS") return "business";
  if (value === "INDIVIDUAL") return "private";
  return null;
}

const toDate = (iso: string | undefined): Date | null => (iso === undefined ? null : new Date(iso));

export function toListingCandidate(item: ItemSummaryInput, fetchedAt: Date): ListingResult {
  const priceCents = item.price ? parseAmountCents(item.price.value) : null;
  if (!item.legacyItemId || !item.price || priceCents === null) return { ok: false, reason: "malformed" };
  if (item.price.currency !== "EUR") return { ok: false, reason: "not_eur" };
  const shippingCents = shippingCentsToDe(item);
  const itemEndAt = toDate(item.itemEndDate);
  const feedbackPercent = item.seller?.feedbackPercentage === undefined ? null : Number(item.seller.feedbackPercentage);
  return {
    ok: true,
    listing: {
      itemId: item.itemId,
      legacyItemId: item.legacyItemId,
      title: item.title ?? "",
      priceCents,
      shippingCents,
      landedCents: shippingCents === null ? null : priceCents + shippingCents,
      shippingKnown: shippingCents !== null,
      buyingOptions: item.buyingOptions ?? [],
      itemGroup: item.itemGroupType !== undefined || item.itemGroupHref !== undefined,
      conditionId: item.conditionId ?? null,
      conditionText: item.condition ?? null,
      seller: {
        feedbackScore: item.seller?.feedbackScore ?? null,
        feedbackPercent: feedbackPercent !== null && Number.isFinite(feedbackPercent) ? feedbackPercent : null,
        accountType: accountType(item.seller?.sellerAccountType),
      },
      categoryIds: item.leafCategoryIds ?? item.categories?.map((c) => c.categoryId) ?? [],
      itemCreationAt: toDate(item.itemCreationDate),
      itemEndAt,
      fetchedAt,
      contentExpiresAt: contentExpiresAt(fetchedAt, itemEndAt),
    },
  };
}
