import { describe, expect, it } from "vitest";
import fixture from "./market-cases.v1.json" with { type: "json" };
import type { ConditionGroup } from "../match/condition-groups.js";
import type { MarketValueStatus } from "../product.js";
import {
  computeMarketValue,
  MARKET_VALUE_METHOD_VERSION,
  type MarketListingRow,
  type MarketSource,
} from "./market-value.js";

// Synthetic sets (ADR 0023: no real eBay content). The expected values come from
// reference/mv1_reference.py, a separate implementation of spec 6.2 in Python; run it again to
// rebuild this fixture after a method change. Times are days before the case's `at`.
type FixtureRow = {
  key: string;
  landedCents: number;
  originDaysAgo: number | null;
  firstSeenDaysAgo: number;
  lastSeenDaysAgo: number;
  conditionGroup: ConditionGroup | null;
  matchVersion: number;
  source: MarketSource;
  unitTotal: number | null;
  bestOffer: boolean;
  excludedReason: string | null;
};

type FixtureCase = {
  id: string;
  note: string;
  at: string;
  input: {
    conditionGroup: ConditionGroup;
    matchVersion: number;
    source: MarketSource;
    perGb: boolean;
    capped: boolean;
    wrongProductItemKeys: string[];
  };
  expect: {
    status: MarketValueStatus;
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
  rows: FixtureRow[];
};

type Fixture = { methodVersion: string; cases: FixtureCase[] };

// JSON imports widen string unions to string, so the fixture is checked against its shape once
// here; a mistyped group or source fails the golden case that uses it.
const FIXTURE = fixture as Fixture;
const DAY_MS = 86_400_000;

const daysBefore = (at: Date, days: number): Date => new Date(at.getTime() - Math.round(days * DAY_MS));

function rowsOf(c: FixtureCase): MarketListingRow[] {
  const at = new Date(c.at);
  return c.rows.map((r) => ({
    itemKey: r.key,
    source: r.source,
    conditionGroup: r.conditionGroup,
    matchVersion: r.matchVersion,
    landedCents: r.landedCents,
    unitTotal: r.unitTotal,
    originAt: r.originDaysAgo === null ? null : daysBefore(at, r.originDaysAgo),
    firstSeenAt: daysBefore(at, r.firstSeenDaysAgo),
    lastSeenAt: daysBefore(at, r.lastSeenDaysAgo),
    bestOffer: r.bestOffer,
    excludedReason: r.excludedReason,
  }));
}

describe("mv-1 golden cases", () => {
  it("is the method version the fixture was built for", () => {
    expect(FIXTURE.methodVersion).toBe(MARKET_VALUE_METHOD_VERSION);
  });

  it("covers every status and the capped warning", () => {
    expect(new Set(FIXTURE.cases.map((c) => c.expect.status))).toEqual(new Set(["none", "rough", "ok"]));
    expect(FIXTURE.cases.some((c) => c.input.capped && c.expect.status === "ok")).toBe(true);
  });

  it.each(FIXTURE.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const at = new Date(c.at);
    const result = computeMarketValue(rowsOf(c), { ...c.input, wrongProductItemKeys: new Set(c.input.wrongProductItemKeys), at });
    const e = c.expect;
    expect(result).toMatchObject({
      methodVersion: MARKET_VALUE_METHOD_VERSION,
      conditionGroup: c.input.conditionGroup,
      matchVersion: c.input.matchVersion,
      computedAt: at,
      capped: c.input.capped,
      status: e.status,
      n: e.n,
      mCents: e.mCents,
      p25Cents: e.p25Cents,
      p75Cents: e.p75Cents,
      loCents: e.loCents,
      hiCents: e.hiCents,
      valueCents: e.valueCents,
    });
    expect(result.counts).toEqual(e.counts);
    expect(result.neff).toBeCloseTo(e.neff, 9);
    for (const [actual, expected] of [
      [result.halfWidth, e.halfWidth],
      [result.bestOfferShare, e.bestOfferShare],
    ] as const) {
      if (expected === null) expect(actual).toBeNull();
      else expect(actual).toBeCloseTo(expected, 9);
    }
  });
});
