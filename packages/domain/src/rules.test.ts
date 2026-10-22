import { describe, expect, it } from "vitest";
import {
  checkPriceBand,
  pollPriceFilter,
  segmentFloorCents,
  startingFeed,
  startingSegmentRule,
  sweepBand,
} from "./rules.js";
import { SEGMENTS } from "./segments.js";

describe("checkPriceBand, per item", () => {
  const rule = startingSegmentRule("gpu_3090");

  it.each([
    ["at the max", 52000, null],
    ["one cent above the max", 52001, "above_max"],
    ["at the floor", 26000, null],
    ["one cent below the floor", 25999, "below_floor"],
    ["inside the band", 48900, null],
  ])("a landed price %s gives %s", (_name, landedCents, reason) => {
    expect(checkPriceBand(rule, { priceCents: landedCents - 1000, landedCents }, null)).toBe(reason);
  });
});

describe("checkPriceBand, per GB", () => {
  const rule = startingSegmentRule("ram_ddr4");

  it.each([
    ["32 GB at exactly EUR 3.20/GB", 32, 10240, null],
    ["32 GB one cent above EUR 3.20/GB", 32, 10241, "above_max"],
    ["32 GB at exactly EUR 1.60/GB", 32, 5120, null],
    ["32 GB one cent below EUR 1.60/GB", 32, 5119, "below_floor"],
    ["64 GB at EUR 2.00/GB", 64, 12800, null],
    ["48 GB at EUR 3.21/GB", 48, 15408, "above_max"],
    ["96 GB at EUR 1.59/GB", 96, 15264, "below_floor"],
  ])("%s gives %s", (_name, totalGb, landedCents, reason) => {
    expect(checkPriceBand(rule, { priceCents: landedCents, landedCents }, totalGb)).toBe(reason);
  });
});

describe("segmentFloorCents", () => {
  it.each([
    ["gpu_3090", 26000],
    ["ram_ddr4", 5120],
    ["ram_ddr5", 8960],
    ["pc_4090", 96000],
  ] as const)("%s has the floor %i cents (per GB: min_total_gb x min_cents_per_gb)", (segment, cents) => {
    expect(segmentFloorCents(startingSegmentRule(segment))).toBe(cents);
  });
});

describe("poll price filter from the seed rows", () => {
  const rules = SEGMENTS.map(startingSegmentRule);

  it.each([
    ["gpu", { floorEur: 260, ceilingEur: 2400 }],
    ["ram", { floorEur: 51, ceilingEur: 1200 }],
    ["pc", { floorEur: 960, ceilingEur: 3600 }],
  ] as const)("feed %s polls %j", (feedId, expected) => {
    expect(pollPriceFilter(startingFeed(feedId), rules)).toEqual(expected);
  });
});

describe("sweep band from the seed rows", () => {
  it.each([
    ["gpu_3090", { floorEur: 260, ceilingEur: 520 }],
    ["gpu_3090ti", { floorEur: 300, ceilingEur: 600 }],
    ["gpu_4090", { floorEur: 640, ceilingEur: 1280 }],
    ["ram_ddr4", { floorEur: 51, ceilingEur: 204 }],
    ["ram_ddr5", { floorEur: 89, ceilingEur: 358 }],
    ["pc_4090", { floorEur: 960, ceilingEur: 1920 }],
  ] as const)("segment %s sweeps %j", (segment, expected) => {
    expect(sweepBand(startingSegmentRule(segment))).toEqual(expected);
  });
});
