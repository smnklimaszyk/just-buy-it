import type { FeedId, Segment } from "./segments.js";

// The domain shape of an app.segment_rule row. Prices are integer cents and compare against the
// landed price (item + shipping to DE), or the item price alone while shipping is unknown.
type SegmentRuleBase = {
  segment: Segment;
  feedId: FeedId;
  sweepQ: string;
  candidateCapPerDay: number;
  enabled: boolean;
  ruleVersion: number;
};

export type PerItemRule = SegmentRuleBase & { kind: "per_item"; maxLandedCents: number; floorCents: number };

export type PerGbRule = SegmentRuleBase & {
  kind: "per_gb";
  maxCentsPerGb: number;
  minCentsPerGb: number;
  minTotalGb: number;
};

export type SegmentRule = PerItemRule | PerGbRule;

const base = { candidateCapPerDay: 150, enabled: true, ruleVersion: 1 };

// Starting values of section 3.3 (80% and 40% of assumed typical asking prices), seeded by
// migration 0006 and replaced by the live price read.
const STARTING_SEGMENT_RULES: Record<Segment, SegmentRule> = {
  gpu_3090: { ...base, segment: "gpu_3090", feedId: "gpu", sweepQ: "(3090,rtx3090)", kind: "per_item", maxLandedCents: 52000, floorCents: 26000 },
  gpu_3090ti: { ...base, segment: "gpu_3090ti", feedId: "gpu", sweepQ: "3090", kind: "per_item", maxLandedCents: 60000, floorCents: 30000 },
  gpu_4090: { ...base, segment: "gpu_4090", feedId: "gpu", sweepQ: "(4090,rtx4090)", kind: "per_item", maxLandedCents: 128000, floorCents: 64000 },
  ram_ddr4: { ...base, segment: "ram_ddr4", feedId: "ram", sweepQ: "ddr4", kind: "per_gb", maxCentsPerGb: 320, minCentsPerGb: 160, minTotalGb: 32 },
  ram_ddr5: { ...base, segment: "ram_ddr5", feedId: "ram", sweepQ: "ddr5", kind: "per_gb", maxCentsPerGb: 560, minCentsPerGb: 280, minTotalGb: 32 },
  pc_4090: { ...base, segment: "pc_4090", feedId: "pc", sweepQ: "(4090,rtx4090)", kind: "per_item", maxLandedCents: 192000, floorCents: 96000 },
};

export function startingSegmentRule(segment: Segment): SegmentRule {
  return STARTING_SEGMENT_RULES[segment];
}

// The domain shape of an app.feed row (one feed per leaf category, ADR 0016).
export type FeedConfig = {
  id: FeedId;
  enabled: boolean;
  categoryId: string;
  q: string;
  // Read ceiling: about 1.5 x the typical asking price of the dearest segment of the feed.
  priceCeilingCents: number;
  conditionIds: string[];
  dayIntervalS: number;
  nightIntervalS: number;
  overflowPagesPerDay: number;
};

const feedBase = { enabled: false, conditionIds: ["1500", "2500", "3000"], dayIntervalS: 120, nightIntervalS: 600, overflowPagesPerDay: 20 };

// Section 3.2. Feeds are seeded paused; RAM and PC category IDs are checked in live step L3.
const STARTING_FEEDS: Record<FeedId, FeedConfig> = {
  gpu: { ...feedBase, id: "gpu", categoryId: "27386", q: "(3090,4090,rtx3090,rtx4090)", priceCeilingCents: 240000 },
  ram: { ...feedBase, id: "ram", categoryId: "170083", q: "(ddr4,ddr5)", priceCeilingCents: 120000 },
  pc: { ...feedBase, id: "pc", categoryId: "179", q: "(4090,rtx4090)", priceCeilingCents: 360000 },
};

export function startingFeed(feedId: FeedId): FeedConfig {
  return STARTING_FEEDS[feedId];
}

// The lowest price a qualifying listing of the segment may have. Per GB: the minimum total size
// at the minimum rate.
export function segmentFloorCents(rule: SegmentRule): number {
  return rule.kind === "per_item" ? rule.floorCents : rule.minTotalGb * rule.minCentsPerGb;
}

const wholeEurosDown = (cents: number): number => Math.floor(cents / 100);

export type PriceFilter = { floorEur: number; ceilingEur: number };

// The eBay price filter of a poll: the lowest segment floor of the feed up to its read ceiling,
// so the poll also sees listings above the max for the price read (section 3.2).
export function pollPriceFilter(feed: FeedConfig, rules: readonly SegmentRule[]): PriceFilter {
  const floors = rules.filter((r) => r.feedId === feed.id).map(segmentFloorCents);
  return { floorEur: wholeEurosDown(Math.min(...floors)), ceilingEur: wholeEurosDown(feed.priceCeilingCents) };
}

// Kits up to this size are inside the per-GB sweep band at the max; larger kits come through the poll.
export const SWEEP_MAX_KIT_GB = 64;

// The eBay price filter of a segment's sweep: its own deal band, floor to max.
export function sweepBand(rule: SegmentRule): PriceFilter {
  const maxCents = rule.kind === "per_item" ? rule.maxLandedCents : rule.maxCentsPerGb * SWEEP_MAX_KIT_GB;
  return { floorEur: wholeEurosDown(segmentFloorCents(rule)), ceilingEur: wholeEurosDown(maxCents) };
}

export type PricePoint = { priceCents: number; landedCents: number | null };

// Rules 19 and 20 of the classifier.
export function checkPriceBand(rule: SegmentRule, price: PricePoint, totalGb: number | null): "below_floor" | "above_max" | null {
  const checked = price.landedCents ?? price.priceCents;
  if (rule.kind === "per_item") {
    if (checked < rule.floorCents) return "below_floor";
    if (checked > rule.maxLandedCents) return "above_max";
    return null;
  }
  // The classifier rejects a RAM listing without a capacity (rule 17) before this check.
  if (totalGb === null) throw new Error("a per-GB rule needs the total GB");
  // Compared as whole cents (price against rate x GB), so no rounding of a per-GB price is involved.
  if (checked < rule.minCentsPerGb * totalGb) return "below_floor";
  if (checked > rule.maxCentsPerGb * totalGb) return "above_max";
  return null;
}
