// A limit already resolved for one condition group (market/limit.ts). Per GB when the product
// prices per GB, else for the whole item.
export type ResolvedLimit = { limitCents: number; floorCents: number };

export type ListingPrice = { priceCents: number; landedCents: number | null };

// Section 3.4 step 7. The landed price is checked, or the item price alone while shipping is
// unknown. Per GB (`unitTotal` given) the price is compared with rate x total in whole cents, so
// no per-GB price is ever rounded.
export function checkLimitBand(
  limit: ResolvedLimit,
  price: ListingPrice,
  unitTotal: number | null,
): "below_floor" | "above_max" | null {
  const checked = price.landedCents ?? price.priceCents;
  const units = unitTotal ?? 1;
  if (checked < limit.floorCents * units) return "below_floor";
  if (checked > limit.limitCents * units) return "above_max";
  return null;
}
