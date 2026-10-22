import { describe, expect, it } from "vitest";
import type { ClassifyResult } from "./classify/classify.js";
import { decideSighting, nextPageDecision, type SightingDecision, type SightingInput } from "./poll-rules.js";

describe("nextPageDecision", () => {
  const page = (extra: Partial<Parameters<typeof nextPageDecision>[0]> = {}) => ({
    page: 1,
    allUnseen: true,
    hasMore: true,
    baseline: false,
    overflowPagesUsedToday: 0,
    overflowPagesPerDay: 20,
    ...extra,
  });

  it.each([
    ["page 1 all unseen", page(), { fetchNext: true, capReached: false }],
    ["page 1 with a seen item", page({ allUnseen: false }), { fetchNext: false, capReached: false }],
    ["page 1 of a baseline poll", page({ baseline: true }), { fetchNext: false, capReached: false }],
    ["page 1 without a next page", page({ hasMore: false }), { fetchNext: false, capReached: false }],
    ["page 2 all unseen", page({ page: 2, overflowPagesUsedToday: 1 }), { fetchNext: true, capReached: false }],
    ["page 3 still all unseen", page({ page: 3, overflowPagesUsedToday: 2 }), { fetchNext: false, capReached: true }],
    ["page 3 with a seen item", page({ page: 3, allUnseen: false }), { fetchNext: false, capReached: false }],
    ["page 1 with 20 overflow pages used today", page({ overflowPagesUsedToday: 20 }), { fetchNext: false, capReached: true }],
    ["page 1 with 19 overflow pages used today", page({ overflowPagesUsedToday: 19 }), { fetchNext: true, capReached: false }],
  ])("%s", (_name, input, expected) => {
    expect(nextPageDecision(input)).toEqual(expected);
  });
});

describe("decideSighting", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const fresh = new Date("2026-10-21T11:00:00Z");
  const old = new Date("2026-10-20T11:59:59Z");
  const candidate: ClassifyResult = { outcome: "candidate", segment: "gpu_3090", flags: [], totalGb: null };
  const aboveMax: ClassifyResult = { outcome: "rejected", reason: "above_max", segment: "gpu_3090", totalGb: null };
  const wanted: ClassifyResult = { outcome: "rejected", reason: "wanted_ad", segment: null, totalGb: null };
  const base = {
    source: "poll" as const,
    baseline: false,
    existing: null,
    itemCreationAt: fresh,
    now,
    classification: candidate,
    candidatesToday: 0,
    candidateCapPerDay: 150,
    segmentEnabled: true,
  };

  it.each([
    ["a new item in band", base, { outcome: "candidate", makeCandidate: true, priceSample: true }],
    ["a new item above the max", { ...base, classification: aboveMax }, { outcome: "above_max", makeCandidate: false, priceSample: true }],
    ["a new wanted ad", { ...base, classification: wanted }, { outcome: "wanted_ad", makeCandidate: false, priceSample: false }],
    ["a baseline poll", { ...base, baseline: true }, { outcome: "baseline", makeCandidate: false, priceSample: true }],
    ["a first sighting 24 h + 1 s old", { ...base, itemCreationAt: old }, { outcome: "too_old", makeCandidate: false, priceSample: true }],
    ["a new item in band from a sweep", { ...base, source: "sweep" as const }, { outcome: "candidate", makeCandidate: true, priceSample: false }],
    ["the 151st candidate of the day", { ...base, candidatesToday: 150 }, { outcome: "over_cap", makeCandidate: false, priceSample: true }],
    ["the 150th candidate of the day", { ...base, candidatesToday: 149 }, { outcome: "candidate", makeCandidate: true, priceSample: true }],
    ["a tracked item, first above the max, now in band and old", { ...base, itemCreationAt: old, existing: { outcome: "above_max", isCandidate: false } }, { outcome: "candidate", makeCandidate: true, priceSample: false }],
    ["an item that already was a candidate", { ...base, existing: { outcome: "candidate", isCandidate: true } }, { outcome: "candidate", makeCandidate: false, priceSample: false }],
    ["a too-old item seen again in band", { ...base, existing: { outcome: "too_old", isCandidate: false } }, { outcome: "too_old", makeCandidate: false, priceSample: false }],
    ["a baseline item seen again in band", { ...base, existing: { outcome: "baseline", isCandidate: false } }, { outcome: "baseline", makeCandidate: false, priceSample: false }],
    ["an over-cap item seen again under the cap", { ...base, existing: { outcome: "over_cap", isCandidate: false } }, { outcome: "candidate", makeCandidate: true, priceSample: false }],
    ["a baseline poll seeing a new item above the max", { ...base, baseline: true, classification: aboveMax }, { outcome: "above_max", makeCandidate: false, priceSample: true }],
    ["a baseline poll seeing a new wanted ad", { ...base, baseline: true, classification: wanted }, { outcome: "wanted_ad", makeCandidate: false, priceSample: false }],
    ["a new item in band of a disabled segment", { ...base, segmentEnabled: false }, { outcome: "segment_off", makeCandidate: false, priceSample: true }],
    ["a new item above the max of a disabled segment", { ...base, segmentEnabled: false, classification: aboveMax }, { outcome: "above_max", makeCandidate: false, priceSample: true }],
    ["a disabled-segment item seen again after the segment was enabled", { ...base, existing: { outcome: "segment_off", isCandidate: false } }, { outcome: "candidate", makeCandidate: true, priceSample: false }],
    ["a baseline poll seeing an item another feed tracks", { ...base, baseline: true, existing: { outcome: "above_max", isCandidate: false } }, { outcome: "above_max", makeCandidate: false, priceSample: false }],
  ] satisfies [string, SightingInput, SightingDecision][])("%s", (_name, input, expected) => {
    expect(decideSighting(input)).toEqual(expected);
  });
});
