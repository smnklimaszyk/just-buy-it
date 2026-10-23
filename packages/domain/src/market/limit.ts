import type { ConditionGroup } from "../match/condition-groups.js";
import type { ResolvedLimit } from "../match/price-band.js";
import { DEFAULT_FLOOR_SHARE_PCT, type MarketValueStatus, type PriceMode, type ProductRules } from "../product.js";

// The product fields the limit depends on (spec 6.4).
export type LimitProduct = Pick<ProductRules, "priceMode" | "maxCents" | "belowMarketPct" | "floorCents" | "perGb"> & {
  matchVersion: number;
};

// An app.market_value row as the limit reads it. Cents per GB when the product prices per GB.
export type MarketValueRef = {
  id: string;
  conditionGroup: ConditionGroup;
  matchVersion: number;
  computedAt: Date;
  status: MarketValueStatus;
  capped: boolean;
  valueCents: number | null;
};

// The limit and floor of one condition group, per GB when the product prices per GB. In market
// mode without a usable value the cap applies and `usingCap` is set, so the products list, the
// product page and the email can say "using your cap".
export type LimitResolution = ResolvedLimit & {
  priceMode: PriceMode;
  usingCap: boolean;
  marketValue: { id: string; valueCents: number; computedAt: Date; outOfDate: boolean } | null;
};

const shareOf = (cents: number, pct: number): number => Math.floor((cents * pct) / 100);

// Limits are rounded down to EUR 10, per GB to EUR 0.10.
const ROUND_ITEM_CENTS = 1_000;
const ROUND_PER_GB_CENTS = 10;

const HOUR_MS = 3_600_000;

// Owner decision 7: the last reliable value is used for up to 7 days, then the cap.
export const MARKET_VALUE_MAX_AGE_MS = 7 * 24 * HOUR_MS;

// Spec 6.2: a value is out of date more than 48 hours after it was computed. Worked out when
// read, never stored; an out-of-date value is still used for the limit.
export const MARKET_VALUE_OUT_OF_DATE_MS = 48 * HOUR_MS;

export const isOutOfDate = (computedAt: Date, now: Date): boolean =>
  now.getTime() - computedAt.getTime() > MARKET_VALUE_OUT_OF_DATE_MS;

const newestOf = (values: readonly MarketValueRef[]): MarketValueRef | undefined =>
  values.reduce<MarketValueRef | undefined>((newest, value) => (newest === undefined || value.computedAt > newest.computedAt ? value : newest), undefined);

const withinMaxAge = (computedAt: Date, at: Date): boolean => at.getTime() - computedAt.getTime() <= MARKET_VALUE_MAX_AGE_MS;

// The newest `ok` value of the group and the product's current match version computed before
// `at` and at most 7 days before it. `at` is the listing's first sighting, so a cheap listing
// cannot pull its own reference down. When none came before `at` (the rules changed after the
// first sighting, or the value of that time is purged), the newest one up to `now` that is at
// most 7 days old, rather than the cap.
function usableValue(
  product: LimitProduct,
  conditionGroup: ConditionGroup,
  values: readonly MarketValueRef[],
  at: Date,
  now: Date,
): MarketValueRef | undefined {
  const current = values.filter(
    (value) =>
      value.conditionGroup === conditionGroup &&
      value.matchVersion === product.matchVersion &&
      value.status === "ok" &&
      value.valueCents !== null,
  );
  const before = newestOf(current.filter((value) => value.computedAt < at && withinMaxAge(value.computedAt, at)));
  return before ?? newestOf(current.filter((value) => value.computedAt >= at && value.computedAt <= now && withinMaxAge(value.computedAt, now)));
}

// Spec 6.4, for one condition group of a listing first seen at `at`. `now` is when the limit is
// worked out; it differs from `at` for a listing seen before.
export function resolveLimit(
  product: LimitProduct,
  conditionGroup: ConditionGroup,
  values: readonly MarketValueRef[],
  at: Date,
  now: Date = at,
): LimitResolution {
  const value = product.priceMode === "below_market" ? usableValue(product, conditionGroup, values, at, now) : undefined;
  if (product.belowMarketPct === null || value === undefined || value.valueCents === null) {
    return {
      priceMode: product.priceMode,
      limitCents: product.maxCents,
      floorCents: product.floorCents ?? shareOf(product.maxCents, DEFAULT_FLOOR_SHARE_PCT),
      usingCap: product.priceMode === "below_market",
      marketValue: null,
    };
  }
  const below = Math.min(product.maxCents, shareOf(value.valueCents, 100 - product.belowMarketPct));
  const step = product.perGb ? ROUND_PER_GB_CENTS : ROUND_ITEM_CENTS;
  // At least one step, so a value under about EUR 12 does not give a limit of 0; never above the cap.
  const limitCents = Math.min(product.maxCents, Math.max(step, Math.floor(below / step) * step));
  return {
    priceMode: product.priceMode,
    limitCents,
    // Above 60 % below the value, 40 % of it would be over the limit: then half the limit.
    floorCents: product.floorCents ?? Math.min(shareOf(value.valueCents, DEFAULT_FLOOR_SHARE_PCT), shareOf(limitCents, 50)),
    usingCap: false,
    marketValue: {
      id: value.id,
      valueCents: value.valueCents,
      computedAt: value.computedAt,
      outOfDate: isOutOfDate(value.computedAt, now),
    },
  };
}
