import { describe, expect, it } from "vitest";
import { priceStatistics, suggestRule } from "./prices.js";

const rows = (landed: (number | null)[], totalGb: number | null = null) =>
  landed.map((landedCents) => ({ landedCents, totalGb }));

describe("priceStatistics", () => {
  it("gives n and the quartiles of the landed price on a fixed set, unknown shipping left out", () => {
    const set = rows([1000, 300, 200, null, 500, 400, 600, 100, 800, 700, 900, null]);
    expect(priceStatistics(set, "per_item")).toEqual({ n: 10, p25: 325, p50: 550, p75: 775, landedP75: 775 });
  });

  it("uses landed / total GB for per-GB segments and leaves out rows without a size", () => {
    const set = [
      { landedCents: 9600, totalGb: 32 },
      { landedCents: 12800, totalGb: 32 },
      { landedCents: 19200, totalGb: 64 },
      { landedCents: 32000, totalGb: 64 },
      { landedCents: 5000, totalGb: null },
    ];
    expect(priceStatistics(set, "per_gb")).toEqual({ n: 4, p25: 300, p50: 350, p75: 425, landedP75: 22400 });
  });
});

describe("suggestRule", () => {
  const stats = (n: number, p25: number, p50: number, landedP75: number) => ({ n, p25, p50, p75: landedP75, landedP75 });
  const GPU_CEILING = 240000;
  const RAM_CEILING = 120000;

  it.each([
    ["n = 19 gives none", stats(19, 48000, 65000, 80000), "per_item", GPU_CEILING, { kind: "none", reason: "too_few" }],
    ["n = 20, p25 below 0.8 x p50", stats(20, 48000, 65000, 80000), "per_item", GPU_CEILING, { kind: "per_item", maxLandedCents: 48000, floorCents: 26000 }],
    ["0.8 x p50 below p25", stats(20, 61234, 65000, 80000), "per_item", GPU_CEILING, { kind: "per_item", maxLandedCents: 52000, floorCents: 26000 }],
    ["rounded down to EUR 10", stats(20, 60000, 64990, 80000), "per_item", GPU_CEILING, { kind: "per_item", maxLandedCents: 51000, floorCents: 25000 }],
    ["per GB, rounded down to EUR 0.10", stats(25, 350, 433, 20000), "per_gb", RAM_CEILING, { kind: "per_gb", maxCentsPerGb: 340, minCentsPerGb: 170 }],
    ["per GB, p25 lower", stats(25, 315, 400, 20000), "per_gb", RAM_CEILING, { kind: "per_gb", maxCentsPerGb: 310, minCentsPerGb: 160 }],
    ["p75 at 90% of the read ceiling", stats(30, 48000, 65000, 216000), "per_item", GPU_CEILING, { kind: "none", reason: "cut_off" }],
    ["p75 just under 90% of the read ceiling", stats(30, 48000, 65000, 215999), "per_item", GPU_CEILING, { kind: "per_item", maxLandedCents: 48000, floorCents: 26000 }],
    ["n = 19 with a cut-off read", stats(19, 48000, 65000, 216000), "per_item", GPU_CEILING, { kind: "none", reason: "too_few" }],
  ] as const)("%s", (_name, s, kind, ceiling, expected) => {
    expect(suggestRule(s, kind, ceiling)).toEqual(expected);
  });
});
