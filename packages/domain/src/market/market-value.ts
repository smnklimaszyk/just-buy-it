import type { ConditionGroup } from "../match/condition-groups.js";
import type { MarketValueStatus } from "../product.js";

// Spec 6 and ADR 0040. Changing any constant of this file is a new method version.
export const MARKET_VALUE_METHOD_VERSION = "mv-1";

const DAY_MS = 86_400_000;

export type MarketSource = "ebay" | "kleinanzeigen";

// One app.market_listing row (spec 2.4). `landedCents` is the whole listing; per GB the value
// uses landed / unitTotal.
export type MarketListingRow = {
  itemKey: string;
  source: MarketSource;
  conditionGroup: ConditionGroup | null;
  matchVersion: number;
  landedCents: number;
  unitTotal: number | null;
  originAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  bestOffer: boolean;
  excludedReason: string | null;
};

// `capped` comes from the snapshot: it hit its page cap with more than 10 % of the weight unread.
// `wrongProductItemKeys` are listings Claude called `wrong_product`.
export type MarketValueInput = {
  conditionGroup: ConditionGroup;
  matchVersion: number;
  source: MarketSource;
  perGb: boolean;
  capped: boolean;
  wrongProductItemKeys: ReadonlySet<string>;
  at: Date;
};

// The columns of one app.market_value row. Cents are per GB when the product prices per GB.
// `counts` holds the listings left out, by reason; only reasons that occurred are listed.
export type MarketValueResult = {
  methodVersion: typeof MARKET_VALUE_METHOD_VERSION;
  conditionGroup: ConditionGroup;
  matchVersion: number;
  computedAt: Date;
  status: MarketValueStatus;
  capped: boolean;
  n: number;
  neff: number;
  mCents: number | null;
  p25Cents: number | null;
  p75Cents: number | null;
  loCents: number | null;
  hiCents: number | null;
  halfWidth: number | null;
  bestOfferShare: number | null;
  valueCents: number | null;
  counts: Record<string, number>;
};

// Spec 6.2: the pool is the listings seen in the last 30 days.
const POOL_DAYS = 30;

// Spec 6.2 steps 1 and 2.
const TOO_CHEAP_SHARE = 0.6;
const MAD_SCALE = 1.4826;
const OUTLIER_Z = 3.5;

type Ask = Weighted & { bestOffer: boolean };

export function computeMarketValue(rows: readonly MarketListingRow[], input: MarketValueInput): MarketValueResult {
  const counts: Record<string, number> = {};
  const count = (reason: string, by: number): void => {
    if (by > 0) counts[reason] = (counts[reason] ?? 0) + by;
  };
  const windowStart = input.at.getTime() - POOL_DAYS * DAY_MS;
  const pool: Ask[] = [];
  for (const r of rows) {
    const inPool =
      r.conditionGroup === input.conditionGroup &&
      r.matchVersion === input.matchVersion &&
      r.source === input.source &&
      r.lastSeenAt.getTime() >= windowStart;
    if (!inPool) continue;
    if (r.excludedReason !== null) count(r.excludedReason, 1);
    else if (input.wrongProductItemKeys.has(r.itemKey)) count("wrong_product", 1);
    else if (input.perGb && r.unitTotal === null) count("unknown_total", 1);
    else {
      const x = input.perGb && r.unitTotal !== null ? r.landedCents / r.unitTotal : r.landedCents;
      pool.push({ x, w: listingWeight(r.originAt ?? r.firstSeenAt, input.at), bestOffer: r.bestOffer });
    }
  }
  // Every sum below runs in this order, so the row order cannot change a single bit.
  pool.sort((a, b) => a.x - b.x || a.w - b.w);
  const base: Pick<MarketValueResult, "methodVersion" | "conditionGroup" | "matchVersion" | "computedAt" | "capped" | "counts"> = {
    methodVersion: MARKET_VALUE_METHOD_VERSION,
    conditionGroup: input.conditionGroup,
    matchVersion: input.matchVersion,
    computedAt: input.at,
    capped: input.capped,
    counts,
  };
  if (pool.length === 0) {
    return {
      ...base,
      status: "none",
      n: 0,
      neff: 0,
      mCents: null,
      p25Cents: null,
      p75Cents: null,
      loCents: null,
      hiCents: null,
      halfWidth: null,
      bestOfferShare: null,
      valueCents: null,
    };
  }

  // 1. Weighted median m0; asks below 0.6 x m0 are scams, parts or another product.
  const m0 = weightedQuantile(pool, 0.5);
  const priced = pool.filter((ask) => ask.x >= TOO_CHEAP_SHARE * m0);
  count("too_cheap", pool.length - priced.length);

  // 2. Modified z: the weighted MAD of the asks step 1 kept, around their own weighted median
  // m1. Asks more than 3.5 spreads above m1 are bundles or dealer prices. Only the high side:
  // the low side was cut in step 1. Around m0 instead, a scam that step 1 drops would still
  // widen the spread and could let a dealer ask back in.
  const m1 = weightedQuantile(priced, 0.5);
  const s = MAD_SCALE * weightedQuantile(priced.map((ask) => ({ x: Math.abs(ask.x - m1), w: ask.w })), 0.5);
  const kept = s === 0 ? priced : priced.filter((ask) => (ask.x - m1) / s <= OUTLIER_Z);
  count("outlier", priced.length - kept.length);

  // 3. Final weighted median, quartiles, effective count and the interval of the median.
  const sumW = kept.reduce((sum, ask) => sum + ask.w, 0);
  const sumW2 = kept.reduce((sum, ask) => sum + ask.w * ask.w, 0);
  const neff = (sumW * sumW) / sumW2;
  const m = weightedQuantile(kept, 0.5);
  const reach = 0.98 / Math.sqrt(neff);
  const lo = weightedQuantile(kept, Math.max(0, 0.5 - reach));
  const hi = weightedQuantile(kept, Math.min(1, 0.5 + reach));
  const halfWidth = m > 0 ? Math.max(m - lo, hi - m) / m : null;
  const mCents = Math.round(m);
  return {
    ...base,
    status: statusOf(neff, halfWidth),
    n: kept.length,
    neff,
    mCents,
    p25Cents: Math.round(weightedQuantile(kept, 0.25)),
    p75Cents: Math.round(weightedQuantile(kept, 0.75)),
    loCents: Math.round(lo),
    hiCents: Math.round(hi),
    halfWidth,
    bestOfferShare: kept.filter((ask) => ask.bestOffer).length / kept.length,
    valueCents: mCents,
  };
}

// Spec 6.2 gates, on the 30-day pool at compute time.
const MIN_NEFF_ROUGH = 8;
const MIN_NEFF_OK = 15;
const MAX_HALF_WIDTH_OK = 0.15;

function statusOf(neff: number, halfWidth: number | null): MarketValueStatus {
  if (neff < MIN_NEFF_ROUGH) return "none";
  if (neff >= MIN_NEFF_OK && halfWidth !== null && halfWidth <= MAX_HALF_WIDTH_OK) return "ok";
  return "rough";
}

// Spec 6.2: a listing's weight halves every 14 days after it first went up, so asks that stay
// unsold for weeks count little. A date after `at` counts as new.
export const HALF_LIFE_DAYS = 14;

export function listingWeight(originAt: Date, at: Date): number {
  const ageDays = Math.max(0, at.getTime() - originAt.getTime()) / DAY_MS;
  return 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

// Spec 6.3: a snapshot reads up to 3 pages of 200, newest first. Pages 2 and 3 are read only
// while the unread listings could carry more than 10 % of the weight; a snapshot that stops at
// the page cap above that share is `capped`.
export const SNAPSHOT_PAGE_SIZE = 200;
export const MAX_SNAPSHOT_PAGES = 3;
export const UNREAD_WEIGHT_SHARE_LIMIT = 0.1;

// The share of the weight the unread listings could carry. They are all older than the last
// row read, so none weighs more than it.
export function unreadWeightShare(input: {
  readWeight: number;
  unread: number;
  oldestReadOriginAt: Date;
  at: Date;
}): number {
  const unreadWeight = input.unread * listingWeight(input.oldestReadOriginAt, input.at);
  return unreadWeight / (input.readWeight + unreadWeight);
}

// A price with its weight.
export type Weighted = { x: number; w: number };

// Weight sums that differ only by rounding count as equal.
const WEIGHT_TOLERANCE = 1e-12;

// The weighted quantile: the lowest price whose cumulative weight reaches p of the total. When the
// cumulative weight lands exactly on p of the total, the middle of that price and the next one,
// so the median of two equal weights is their middle. Points are sorted by price and then weight,
// so the result never depends on the order of the input.
export function weightedQuantile(points: readonly Weighted[], p: number): number {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.w - b.w);
  const total = sorted.reduce((sum, point) => sum + point.w, 0);
  const target = p * total;
  const tolerance = WEIGHT_TOLERANCE * total;
  let cumulative = 0;
  for (const [i, point] of sorted.entries()) {
    cumulative += point.w;
    if (cumulative < target - tolerance) continue;
    const next = sorted[i + 1];
    if (next !== undefined && Math.abs(cumulative - target) <= tolerance) return (point.x + next.x) / 2;
    return point.x;
  }
  const last = sorted.at(-1);
  if (last === undefined) throw new Error("a quantile needs at least one price");
  return last.x;
}
