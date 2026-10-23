import { describe, expect, it } from "vitest";
import { checkLimitBand } from "./price-band.js";

describe("checkLimitBand", () => {
  const limit = { limitCents: 52000, floorCents: 26000 };
  const perGb = { limitCents: 320, floorCents: 160 };

  it.each([
    ["landed at the limit", limit, { priceCents: 49000, landedCents: 52000 }, null, null],
    ["landed a cent above", limit, { priceCents: 49001, landedCents: 52001 }, null, "above_max"],
    ["landed at the floor", limit, { priceCents: 25000, landedCents: 26000 }, null, null],
    ["landed a cent below the floor", limit, { priceCents: 25000, landedCents: 25999 }, null, "below_floor"],
    ["shipping unknown, price at the limit", limit, { priceCents: 52000, landedCents: null }, null, null],
    ["shipping unknown, price above", limit, { priceCents: 52001, landedCents: null }, null, "above_max"],
    ["per GB at the limit", perGb, { priceCents: 9740, landedCents: 10240 }, 32, null],
    ["per GB a cent above", perGb, { priceCents: 9741, landedCents: 10241 }, 32, "above_max"],
    ["per GB below the floor", perGb, { priceCents: 5000, landedCents: 5119 }, 32, "below_floor"],
    ["per GB at the floor", perGb, { priceCents: 5000, landedCents: 5120 }, 32, null],
  ] as const)("%s", (_name, band, price, unitTotal, expected) => {
    expect(checkLimitBand(band, price, unitTotal)).toBe(expected);
  });
});
