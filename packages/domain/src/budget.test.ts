import { describe, expect, it } from "vitest";
import { planDailyCalls } from "./budget.js";
import { startingFeed, startingSegmentRule } from "./rules.js";
import { FEED_IDS, SEGMENTS } from "./segments.js";

const feeds = FEED_IDS.map(startingFeed);
const segments = SEGMENTS.map(startingSegmentRule);

describe("planDailyCalls", () => {
  it("gives the golden worst case of section 3.4 with the seed rows", () => {
    expect(planDailyCalls(feeds, segments, 40)).toEqual({
      polls: 1584,
      overflowPages: 60,
      sweeps: 144,
      getItem: 126,
      total: 1914,
      ceiling: 2500,
      withinCeiling: true,
    });
  });

  it("refuses a 1-minute interval on one feed (over 2,500) and follows the Claude call limit", () => {
    const fast = feeds.map((f) => (f.id === "gpu" ? { ...f, dayIntervalS: 60, nightIntervalS: 60 } : f));
    expect(planDailyCalls(fast, segments, 40)).toMatchObject({ polls: 2496, total: 2826, withinCeiling: false });
    expect(planDailyCalls(feeds, segments, 80).getItem).toBe(246);
    expect(planDailyCalls(feeds, segments, 0).getItem).toBe(6);
  });
});
