import { describe, expect, it } from "vitest";
import { unitTotalFromAspects, unitTotalFromTitle } from "./unit-total.js";

describe("unitTotalFromTitle", () => {
  it.each([
    ["2x16GB", 32],
    ["2 x 16 GB", 32],
    ["2×16GB", 32],
    ["Kit of 4 x 8GB", 32],
    ["Kit of 2 16GB", 32],
    ["32GB (2x16GB)", 32],
    ["64GB 2x32GB", 64],
    ["4x32GB 128GB", 128],
    ["16 GB", 16],
    ["8GB und 16GB", 16],
    ["2x16 GB", 32],
    ["3200MHz CL16", null],
    ["16GBit", null],
    ["", null],
    ["a16gb", null],
  ] as const)("%j gives %s", (title, total) => {
    expect(unitTotalFromTitle(title)).toBe(total);
  });
});

describe("unitTotalFromAspects", () => {
  const aspects = (pairs: Record<string, string>) => Object.entries(pairs).map(([name, value]) => ({ name, value }));

  it.each([
    ["Kapazität", aspects({ Kapazität: "64 GB" }), 64],
    ["Speicherkapazität", aspects({ Speicherkapazität: "32GB" }), 32],
    ["Capacity", aspects({ Capacity: "2 x 16 GB" }), 32],
    ["the name folded", aspects({ " KAPAZITÄT ": "16 GB" }), 16],
    ["another specific with a size", aspects({ Farbe: "64 GB Schwarz" }), null],
    ["no size in the value", aspects({ Kapazität: "groß" }), null],
    ["none", [], null],
  ] as const)("%s", (_name, list, total) => {
    expect(unitTotalFromAspects(list)).toBe(total);
  });
});
