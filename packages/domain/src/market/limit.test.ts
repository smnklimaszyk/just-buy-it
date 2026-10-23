import { describe, expect, it } from "vitest";
import { isOutOfDate, resolveLimit, type LimitProduct, type MarketValueRef } from "./limit.js";

const FIXED: LimitProduct = {
  priceMode: "fixed",
  maxCents: 55_000,
  belowMarketPct: null,
  floorCents: null,
  perGb: false,
  matchVersion: 3,
};

// 15 % below the market, never above EUR 550.
const MARKET: LimitProduct = { ...FIXED, priceMode: "below_market", belowMarketPct: 15 };

const AT = new Date("2026-10-22T14:00:00Z");
const HOUR_MS = 3_600_000;
const hoursBefore = (at: Date, hours: number): Date => new Date(at.getTime() - hours * HOUR_MS);

let counter = 0;
function okValue(overrides: Partial<MarketValueRef> = {}): MarketValueRef {
  counter += 1;
  return {
    id: `0190f0e2-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    conditionGroup: "used",
    matchVersion: 3,
    computedAt: hoursBefore(AT, 10),
    status: "ok",
    capped: false,
    valueCents: 60_000,
    ...overrides,
  };
}

describe("resolveLimit", () => {
  it("uses the max and 40 % of it in fixed mode", () => {
    expect(resolveLimit(FIXED, "used", [], AT)).toEqual({
      priceMode: "fixed",
      limitCents: 55_000,
      floorCents: 22_000,
      usingCap: false,
      marketValue: null,
    });
  });

  it("is the percent below the market value, rounded down to EUR 10, with 40 % of the value as floor", () => {
    const value = okValue({ valueCents: 61_234, computedAt: hoursBefore(AT, 10) });
    expect(resolveLimit(MARKET, "used", [value], AT)).toEqual({
      priceMode: "below_market",
      limitCents: 52_000,
      floorCents: 24_493,
      usingCap: false,
      marketValue: { id: value.id, valueCents: 61_234, computedAt: value.computedAt, outOfDate: false },
    });
  });

  it("keeps the default floor at half the limit for a large percent, so a listing can pass the band", () => {
    // 70 % below a value of EUR 400: limit EUR 120, and 40 % of the value (EUR 160) would be above it.
    expect(resolveLimit({ ...MARKET, belowMarketPct: 70 }, "used", [okValue({ valueCents: 40_000 })], AT)).toMatchObject({
      limitCents: 12_000,
      floorCents: 6_000,
    });
  });

  it("rounds a small limit down to no less than one step of EUR 10, never above the cap", () => {
    expect(resolveLimit(MARKET, "used", [okValue({ valueCents: 1_100 })], AT)).toMatchObject({ limitCents: 1_000, floorCents: 440 });
    expect(resolveLimit({ ...MARKET, maxCents: 800 }, "used", [okValue({ valueCents: 1_100 })], AT)).toMatchObject({ limitCents: 800 });
  });

  it("is never above the cap, also when the cap is not a multiple of EUR 10", () => {
    const value = okValue({ valueCents: 90_000 });
    expect(resolveLimit(MARKET, "used", [value], AT).limitCents).toBe(55_000);
    expect(resolveLimit({ ...MARKET, maxCents: 54_999 }, "used", [value], AT).limitCents).toBe(54_000);
  });

  it("uses the cap and 40 % of it, marked as using the cap, when there is no value", () => {
    expect(resolveLimit(MARKET, "used", [], AT)).toEqual({
      priceMode: "below_market",
      limitCents: 55_000,
      floorCents: 22_000,
      usingCap: true,
      marketValue: null,
    });
  });

  it("resolves each condition group on its own: Used ok gives a market limit, New none the cap", () => {
    const values = [okValue({ conditionGroup: "used" }), okValue({ conditionGroup: "new", status: "none", valueCents: 80_000 })];
    expect(resolveLimit(MARKET, "used", values, AT)).toMatchObject({ limitCents: 51_000, usingCap: false });
    expect(resolveLimit(MARKET, "new", values, AT)).toMatchObject({ limitCents: 55_000, usingCap: true, marketValue: null });
  });

  it("takes the newest ok value of the current match version computed before the first sighting", () => {
    const chosen = okValue({ valueCents: 58_000, computedAt: hoursBefore(AT, 20) });
    const values = [
      okValue({ valueCents: 95_000, computedAt: new Date(AT.getTime() + HOUR_MS) }),
      okValue({ valueCents: 90_000, computedAt: hoursBefore(AT, 2), matchVersion: 2 }),
      okValue({ valueCents: 70_000, computedAt: hoursBefore(AT, 5), status: "rough" }),
      chosen,
      okValue({ valueCents: 60_000, computedAt: hoursBefore(AT, 30) }),
    ];
    expect(resolveLimit(MARKET, "used", values, AT)).toMatchObject({ limitCents: 49_000, marketValue: { id: chosen.id } });
    expect(resolveLimit(MARKET, "used", [...values].reverse(), AT)).toMatchObject({ marketValue: { id: chosen.id } });
  });

  it("takes the newest ok value up to now when none came before the first sighting, as after a rules change", () => {
    const NOW = new Date(AT.getTime() + 3 * 24 * HOUR_MS);
    const afterChange = okValue({ valueCents: 58_000, computedAt: new Date(AT.getTime() + HOUR_MS) });
    const newest = okValue({ valueCents: 62_000, computedAt: new Date(AT.getTime() + 2 * 24 * HOUR_MS) });
    const oldVersion = okValue({ valueCents: 90_000, computedAt: hoursBefore(AT, 2), matchVersion: 2 });

    expect(resolveLimit(MARKET, "used", [afterChange, newest, oldVersion], AT, NOW)).toMatchObject({
      limitCents: 52_000,
      usingCap: false,
      marketValue: { id: newest.id },
    });
    expect(resolveLimit(MARKET, "used", [afterChange], AT, NOW), "71 hours old at now").toMatchObject({ marketValue: { outOfDate: true } });
    // Older than 7 days at `now`: the cap, as for any value past its 7 days.
    const stale = okValue({ computedAt: new Date(AT.getTime() + HOUR_MS) });
    expect(resolveLimit(MARKET, "used", [stale], AT, new Date(AT.getTime() + 8 * 24 * HOUR_MS))).toMatchObject({ usingCap: true });
  });

  it("skips a value whose price the purge has removed, so it cannot hide an older one", () => {
    const older = okValue({ valueCents: 58_000, computedAt: hoursBefore(AT, 30) });
    const purged = okValue({ valueCents: null, computedAt: hoursBefore(AT, 10) });

    expect(resolveLimit(MARKET, "used", [older, purged], AT)).toMatchObject({ usingCap: false, marketValue: { id: older.id } });
  });

  it("keeps the last ok value for 7 days and falls back to the cap 1 minute later", () => {
    const sevenDays = okValue({ computedAt: hoursBefore(AT, 7 * 24) });
    const later = okValue({ computedAt: new Date(sevenDays.computedAt.getTime() - 60_000) });
    expect(resolveLimit(MARKET, "used", [sevenDays], AT)).toMatchObject({ limitCents: 51_000, usingCap: false });
    expect(resolveLimit(MARKET, "used", [later], AT)).toMatchObject({ limitCents: 55_000, usingCap: true, marketValue: null });
  });

  it("marks a value 49 hours old as out of date and still uses it; 48 hours is not out of date", () => {
    const old = okValue({ computedAt: hoursBefore(AT, 49) });
    expect(resolveLimit(MARKET, "used", [old], AT)).toMatchObject({ limitCents: 51_000, marketValue: { outOfDate: true } });
    expect(isOutOfDate(hoursBefore(AT, 48), AT)).toBe(false);
    expect(isOutOfDate(hoursBefore(AT, 49), AT)).toBe(true);
  });

  it("rounds a per-GB limit down to EUR 0.10 per GB", () => {
    const perGb: LimitProduct = { ...MARKET, perGb: true, maxCents: 300 };
    expect(resolveLimit(perGb, "used", [okValue({ valueCents: 187 })], AT)).toMatchObject({ limitCents: 150, floorCents: 74 });
  });

  it("keeps a stored floor in both modes", () => {
    const withFloor = { floorCents: 30_000 };
    expect(resolveLimit({ ...MARKET, ...withFloor }, "used", [okValue()], AT).floorCents).toBe(30_000);
    expect(resolveLimit({ ...MARKET, ...withFloor }, "used", [], AT).floorCents).toBe(30_000);
    expect(resolveLimit({ ...FIXED, ...withFloor }, "used", [okValue()], AT).floorCents).toBe(30_000);
  });

  it("ignores market values in fixed mode, also when a percent is still stored", () => {
    expect(resolveLimit({ ...FIXED, belowMarketPct: 15 }, "used", [okValue()], AT)).toEqual({
      priceMode: "fixed",
      limitCents: 55_000,
      floorCents: 22_000,
      usingCap: false,
      marketValue: null,
    });
  });

  it("uses a capped snapshot's value: capped is a warning, not a status", () => {
    const capped = okValue({ capped: true });
    expect(resolveLimit(MARKET, "used", [capped], AT)).toMatchObject({ limitCents: 51_000, marketValue: { id: capped.id } });
  });

  it("is never above the cap for any value, percent and cap", () => {
    for (let i = 1; i <= 2_000; i++) {
      const maxCents = 1 + ((i * 7_919) % 400_000);
      const product: LimitProduct = { ...MARKET, maxCents, belowMarketPct: 1 + (i % 90), perGb: i % 3 === 0 };
      const value = okValue({ valueCents: (i * 104_729) % 900_000 });
      const limit = resolveLimit(product, "used", [value], AT);
      expect(limit.limitCents, `case ${i}`).toBeLessThanOrEqual(maxCents);
      expect(limit.limitCents, `case ${i}`).toBeGreaterThanOrEqual(0);
    }
  });
});
