import { describe, expect, it } from "vitest";
import {
  computeMarketValue,
  listingWeight,
  MARKET_VALUE_METHOD_VERSION,
  unreadWeightShare,
  weightedQuantile,
  type MarketListingRow,
  type MarketValueInput,
} from "./market-value.js";

const AT = new Date("2026-10-22T02:10:00Z");
const DAY_MS = 86_400_000;
const daysAgo = (days: number): Date => new Date(AT.getTime() - Math.round(days * DAY_MS));

let counter = 0;
function row(landedCents: number, ageDays: number, overrides: Partial<MarketListingRow> = {}): MarketListingRow {
  counter += 1;
  return {
    itemKey: `k${counter}`,
    source: "ebay",
    conditionGroup: "used",
    matchVersion: 2,
    landedCents,
    unitTotal: null,
    originAt: daysAgo(ageDays),
    firstSeenAt: daysAgo(ageDays),
    lastSeenAt: daysAgo(0),
    bestOffer: false,
    excludedReason: null,
    ...overrides,
  };
}

const INPUT: MarketValueInput = {
  conditionGroup: "used",
  matchVersion: 2,
  source: "ebay",
  perGb: false,
  capped: false,
  wrongProductItemKeys: new Set(),
  at: AT,
};

describe("computeMarketValue", () => {
  it("gives none with no price columns when nothing counts", () => {
    expect(computeMarketValue([], INPUT)).toEqual({
      methodVersion: MARKET_VALUE_METHOD_VERSION,
      conditionGroup: "used",
      matchVersion: 2,
      computedAt: AT,
      status: "none",
      capped: false,
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
      counts: {},
    });
  });

  it("drops asks below 0.6 x the first median and high outliers, and counts them", () => {
    const rows = [
      ...[59_000, 59_500, 60_000, 60_500, 61_000, 61_500, 62_000].map((p) => row(p, 2)),
      row(30_000, 2),
      row(150_000, 2),
    ];
    expect(computeMarketValue(rows, INPUT)).toMatchObject({ n: 7, mCents: 60_500, counts: { too_cheap: 1, outlier: 1 } });
  });

  it("measures the spread around the median of the asks step 1 kept, so a dropped scam cannot let a dealer ask back in", () => {
    const rows = [51_000, 52_000, 54_500, 56_000, 56_500, 58_500, 72_000].map((p) => row(p, 2));
    const before = computeMarketValue(rows, INPUT);
    const after = computeMarketValue([...rows, row(10_000, 2)], INPUT);
    expect(before).toMatchObject({ mCents: 55_250, counts: { outlier: 1 } });
    expect(after).toMatchObject({ mCents: 55_250, counts: { too_cheap: 1, outlier: 1 } });
  });

  it("counts only the asked group, match version, source and the last 30 days", () => {
    const counted = Array.from({ length: 5 }, () => row(60_000, 1));
    const result = computeMarketValue(
      [
        ...counted,
        row(10_000, 1, { conditionGroup: "new" }),
        row(10_000, 1, { matchVersion: 1 }),
        row(10_000, 1, { source: "kleinanzeigen" }),
        row(10_000, 31, { lastSeenAt: daysAgo(30.01) }),
      ],
      INPUT,
    );
    expect(result).toMatchObject({ n: 5, mCents: 60_000 });
    expect(result.counts).toEqual({});
  });

  it("counts excluded rows and wrong products by reason, and leaves them out", () => {
    const wrong = row(1_000, 1);
    const result = computeMarketValue(
      [
        ...Array.from({ length: 4 }, () => row(60_000, 1)),
        row(1_000, 1, { excludedReason: "unknown_shipping" }),
        row(1_000, 1, { excludedReason: "unknown_shipping" }),
        row(1_000, 1, { excludedReason: "auction" }),
        wrong,
      ],
      { ...INPUT, wrongProductItemKeys: new Set([wrong.itemKey]) },
    );
    expect(result).toMatchObject({ n: 4, mCents: 60_000 });
    expect(result.counts).toEqual({ unknown_shipping: 2, auction: 1, wrong_product: 1 });
  });

  it("prices per GB of the listing's total and leaves out rows without a total", () => {
    const result = computeMarketValue(
      [row(4_800, 1, { unitTotal: 32 }), row(9_600, 1, { unitTotal: 64 }), row(3_000, 1, { unitTotal: null })],
      { ...INPUT, perGb: true },
    );
    expect(result).toMatchObject({ n: 2, mCents: 150 });
    expect(result.counts).toEqual({ unknown_total: 1 });
  });

  it("weights by the first sighting when the origin date is unknown", () => {
    const withOrigin = computeMarketValue([row(50_000, 0), row(70_000, 14)], INPUT);
    const withoutOrigin = computeMarketValue(
      [row(50_000, 0), row(70_000, 0, { originAt: null, firstSeenAt: daysAgo(14) })],
      INPUT,
    );
    expect(withOrigin.mCents).toBeLessThan(60_000);
    expect(withoutOrigin.mCents).toBe(withOrigin.mCents);
  });

  it("skips the outlier step when the spread is zero", () => {
    const rows = [...Array.from({ length: 6 }, () => row(60_000, 2)), row(90_000, 2)];
    const result = computeMarketValue(rows, INPUT);
    expect(result).toMatchObject({ n: 7, mCents: 60_000 });
    expect(result.counts).toEqual({});
  });

  it("is none below neff 8, rough from 8 to 14 and ok from 15 with a narrow interval", () => {
    const rows = (count: number) => Array.from({ length: count }, (_, i) => row(60_000 + i * 10, 0));
    expect(computeMarketValue(rows(7), INPUT).status).toBe("none");
    expect(computeMarketValue(rows(8), INPUT).status).toBe("rough");
    expect(computeMarketValue(rows(14), INPUT).status).toBe("rough");
    expect(computeMarketValue(rows(15), INPUT).status).toBe("ok");
  });

  it("is rough at neff 15 or more when the interval is wider than 15 %", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(40_000 + i * 2_000, 0));
    const result = computeMarketValue(rows, INPUT);
    expect(result.neff).toBeGreaterThanOrEqual(15);
    expect(result.halfWidth).toBeGreaterThan(0.15);
    expect(result.status).toBe("rough");
  });

  it("keeps the snapshot's capped flag as a warning that does not change the status or value", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(60_000 + (i % 5) * 100, i % 3));
    const open = computeMarketValue(rows, INPUT);
    const capped = computeMarketValue(rows, { ...INPUT, capped: true });
    expect(open.status).toBe("ok");
    expect(capped).toEqual({ ...open, capped: true });
  });
});

// Mulberry32: a small seeded generator, so a failing loop can be replayed by its seed.
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// A market of 20 to 60 asks within 15 % of a base price of EUR 50 to 5,050, listed over the
// last 4 weeks.
function market(
  next: () => number,
  base = 5_000 + Math.floor(next() * 500_000),
  size = 20 + Math.floor(next() * 41),
): MarketListingRow[] {
  return Array.from({ length: size }, () =>
    row(Math.round(base * (0.85 + 0.3 * next())), next() * 28, { bestOffer: next() < 0.3 }),
  );
}

// The same market with up to 5 scams at 20 to 55 % and up to 5 bundles or dealer asks at 1.3 to
// 3 times the base price.
function marketWithStrays(next: () => number): MarketListingRow[] {
  const base = 5_000 + Math.floor(next() * 500_000);
  return [...market(next, base), ...strays(next, base)];
}

function strays(next: () => number, base: number): MarketListingRow[] {
  const scams = Array.from({ length: Math.floor(next() * 6) }, () => row(Math.round(base * (0.2 + 0.35 * next())), next() * 28));
  const high = Array.from({ length: Math.floor(next() * 6) }, () => row(Math.round(base * (1.3 + 1.7 * next())), next() * 28));
  return [...scams, ...high];
}

const valueOf = (rows: readonly MarketListingRow[]): number => {
  const m = computeMarketValue(rows, INPUT).mCents;
  if (m === null) throw new Error("expected a value");
  return m;
};

function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const swap = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = swap;
  }
  return copy;
}

const LOOPS = 300;

describe("computeMarketValue properties", () => {
  it("does not depend on the order of the rows", () => {
    for (let seed = 1; seed <= LOOPS; seed++) {
      const next = random(seed);
      const rows = market(next);
      expect(computeMarketValue(shuffled(rows, next), INPUT), `seed ${seed}`).toEqual(computeMarketValue(rows, INPUT));
    }
  });

  it("never has neff above n", () => {
    for (let seed = 1; seed <= LOOPS; seed++) {
      const result = computeMarketValue(market(random(seed)), INPUT);
      expect(result.neff, `seed ${seed}`).toBeLessThanOrEqual(result.n + 1e-9);
    }
  });

  // "Cheap" is an ask below the too-cheap line: a scam or a part. For an ask between 0.6 x m and
  // m the spread step can let a dealer ask back in, so the value can rise there in rare sets.
  it("never raises the value when a cheap listing is added, also with scams and dealer asks", () => {
    for (let seed = 1; seed <= 2_000; seed++) {
      const next = random(seed);
      const rows = seed % 2 === 0 ? marketWithStrays(next) : market(next);
      const m = valueOf(rows);
      const cheap = row(Math.floor(m * (0.05 + 0.54 * next())), next() * 28);
      expect(valueOf([...rows, cheap]), `seed ${seed}`).toBeLessThanOrEqual(m);
    }
  });

  // Against a market of 60 asks; the 10 extra asks have the ages of 10 of them. With 20 asks,
  // 10 more are a third of the pool and can carry the median with them.
  it("moves at most 3 % for 10 asks at half the value and at most 10 % for 10 at 1.5 x", () => {
    for (let seed = 1; seed <= LOOPS; seed++) {
      const next = random(seed);
      const base = 5_000 + Math.floor(next() * 500_000);
      const rows = seed % 2 === 0 ? [...market(next, base, 60), ...strays(next, base)] : market(next, base, 60);
      const m = valueOf(rows);
      const ages = rows.slice(0, 10).map((r) => (AT.getTime() - (r.originAt ?? AT).getTime()) / DAY_MS);
      const low = ages.map((age) => row(Math.round(m * 0.5), age));
      const high = ages.map((age) => row(Math.round(m * 1.5), age));
      expect(Math.abs(valueOf([...rows, ...low]) - m) / m, `seed ${seed} low`).toBeLessThanOrEqual(0.03);
      expect(Math.abs(valueOf([...rows, ...high]) - m) / m, `seed ${seed} high`).toBeLessThanOrEqual(0.1);
    }
  });
});

describe("unreadWeightShare", () => {
  it("bounds each unread listing by the weight of the oldest one read", () => {
    // 100 unread, each at most as heavy as the 14-day-old last row: 50 of 170.
    expect(unreadWeightShare({ readWeight: 120, unread: 100, oldestReadOriginAt: daysAgo(14), at: AT })).toBeCloseTo(50 / 170, 12);
    expect(unreadWeightShare({ readWeight: 120, unread: 0, oldestReadOriginAt: daysAgo(14), at: AT })).toBe(0);
  });
});

describe("listingWeight", () => {
  it("halves every 14 days and is 1 for a listing from the future", () => {
    expect(listingWeight(daysAgo(0), AT)).toBe(1);
    expect(listingWeight(daysAgo(14), AT)).toBeCloseTo(0.5, 12);
    expect(listingWeight(daysAgo(28), AT)).toBeCloseTo(0.25, 12);
    expect(listingWeight(new Date(AT.getTime() + DAY_MS), AT)).toBe(1);
  });
});

describe("weightedQuantile", () => {
  it("is the middle of two equal weights and the lower or upper price away from the middle", () => {
    expect(weightedQuantile([{ x: 100, w: 1 }, { x: 200, w: 1 }], 0.5)).toBe(150);
    expect(weightedQuantile([{ x: 100, w: 1 }, { x: 200, w: 1 }], 0.1)).toBe(100);
    expect(weightedQuantile([{ x: 100, w: 1 }, { x: 200, w: 1 }], 0.9)).toBe(200);
  });

  it("does not depend on the order of tied prices", () => {
    const a = weightedQuantile([{ x: 100, w: 1 }, { x: 100, w: 0.1 }, { x: 200, w: 1 }], 0.5);
    const b = weightedQuantile([{ x: 100, w: 0.1 }, { x: 100, w: 1 }, { x: 200, w: 1 }], 0.5);
    expect(a).toBe(b);
  });

  it("is the shared price when most of the weight sits on one price", () => {
    const points = [...Array.from({ length: 6 }, () => ({ x: 600, w: 1 })), { x: 900, w: 1 }];
    expect(weightedQuantile(points, 0.5)).toBe(600);
    expect(weightedQuantile(points, 0.8)).toBe(600);
    expect(weightedQuantile(points, 0.9)).toBe(900);
  });
});
