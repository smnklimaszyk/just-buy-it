import { describe, expect, it } from "vitest";
import {
  decideSighting,
  inactiveProductReason,
  isProductKey,
  isSearchId,
  listedBeforeWatchFrom,
  nextPageDecision,
  productSweepDue,
  searchPollDue,
  type SightingDecision,
  type SightingInput,
  type SweepProduct,
} from "./poll-rules.js";
import type { RunRow } from "./schedule.js";

describe("inactiveProductReason (spec 9)", () => {
  it.each([
    ["active", null],
    ["paused", "product_paused"],
    ["draft", "product_paused"],
    ["archived", "product_archived"],
  ] as const)("a pending candidate of a %s product: %s", (status, expected) => {
    expect(inactiveProductReason(status)).toBe(expected);
  });
});

describe("poll payload format (spec 9)", () => {
  it.each([
    ["s1", true],
    ["s123456789012345678", true],
    ["s0", false],
    ["s01", false],
    ["s1234567890123456789", false],
    ["gpu", false],
    [42, false],
  ])("search id %j: %s", (value, expected) => {
    expect(isSearchId(value)).toBe(expected);
  });

  it.each([
    ["p_k3x9ab2cde", true],
    ["gpu_3090", true],
    ["ab", true],
    [`p${"a".repeat(39)}`, true],
    [`p${"a".repeat(40)}`, false],
    ["a", false],
    ["P_upper", false],
    ["1abc", false],
    ["p-dash", false],
    [null, false],
  ])("product key %j: %s", (value, expected) => {
    expect(isProductKey(value)).toBe(expected);
  });
});

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

describe("listedBeforeWatchFrom (spec 5.5)", () => {
  const watchFrom = new Date("2026-10-21T10:00:00Z");
  const after = (ms: number) => new Date(watchFrom.getTime() + ms);

  it.each([
    ["created a second before watch_from", after(-1_000), after(60_000), true],
    ["created at watch_from", watchFrom, after(60_000), false],
    ["created after watch_from", after(1_000), after(60_000), false],
    ["no creation date, 30 minutes after watch_from", null, after(30 * 60_000), true],
    ["no creation date, 30 minutes and 1 ms after watch_from", null, after(30 * 60_000 + 1), false],
    ["a product without a watch_from", after(-1_000), after(60_000), false, null],
  ])("%s", (_name, created, now, expected, from: Date | null = watchFrom) => {
    expect(listedBeforeWatchFrom(created, from, now)).toBe(expected);
  });
});

describe("decideSighting (spec 5.5)", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const fresh = new Date("2026-10-21T11:00:00Z");
  const old = new Date("2026-10-20T11:59:59Z");
  const watchFrom = new Date("2026-10-21T08:00:00Z");
  const active = { status: "active" as const, watchFrom, candidateCapPerDay: 10 };
  const unwatched = { ...active, watchFrom: null };
  const inBand = { outcome: "candidate" as const, productKey: "p_lens" };
  const aboveMax = { outcome: "above_max" as const, productKey: "p_lens" };
  const wanted = { outcome: "wanted_ad" as const, productKey: null };
  const base: SightingInput = {
    source: "poll",
    existing: null,
    itemCreationAt: fresh,
    now,
    match: inBand,
    product: active,
    candidatesToday: 0,
  };
  const seen = (outcome: string, isCandidate = false, productKey: string | null = "p_lens") => ({
    existing: { outcome, isCandidate, productKey },
  });

  it.each([
    ["a new listing in band", base, { outcome: "candidate", makeCandidate: true, priceSample: true }],
    ["a new listing above the limit", { ...base, match: aboveMax }, { outcome: "above_max", makeCandidate: false, priceSample: true }],
    ["a new wanted ad, no product named", { ...base, match: wanted, product: null }, { outcome: "wanted_ad", makeCandidate: false, priceSample: false }],
    ["a first sighting 24 h + 1 s old", { ...base, itemCreationAt: old, product: unwatched }, { outcome: "too_old", makeCandidate: false, priceSample: true }],
    ["a new listing in band from a sweep", { ...base, source: "sweep" as const }, { outcome: "candidate", makeCandidate: true, priceSample: false }],
    ["the 11th candidate of the product today", { ...base, candidatesToday: 10 }, { outcome: "over_cap", makeCandidate: false, priceSample: true }],
    ["the 10th candidate of the product today", { ...base, candidatesToday: 9 }, { outcome: "candidate", makeCandidate: true, priceSample: true }],
    ["tracked above the limit, now in band and old", { ...base, ...seen("above_max"), itemCreationAt: old, product: unwatched }, { outcome: "candidate", makeCandidate: true, priceSample: false }],
    ["a listing that already was a candidate", { ...base, ...seen("candidate", true) }, { outcome: "candidate", makeCandidate: false, priceSample: false }],
    ["a too-old listing seen again in band", { ...base, ...seen("too_old") }, { outcome: "too_old", makeCandidate: false, priceSample: false }],
    ["a baseline listing seen again in band", { ...base, ...seen("baseline") }, { outcome: "baseline", makeCandidate: false, priceSample: false }],
    ["another product's baseline, now in band of this one", { ...base, ...seen("baseline", false, "p_newer") }, { outcome: "candidate", makeCandidate: true, priceSample: false }],
    ["an over-cap listing seen again under the cap", { ...base, ...seen("over_cap") }, { outcome: "candidate", makeCandidate: true, priceSample: false }],
    ["a listing in band of a paused product", { ...base, product: { ...active, status: "paused" as const } }, { outcome: "product_paused", makeCandidate: false, priceSample: true }],
    ["a listing created before watch_from", { ...base, itemCreationAt: new Date("2026-10-21T07:59:59Z") }, { outcome: "baseline", makeCandidate: false, priceSample: true }],
    ["seen above the limit, now in band, created before a new watch_from", { ...base, ...seen("above_max"), itemCreationAt: new Date("2026-10-21T07:59:59Z") }, { outcome: "baseline", makeCandidate: false, priceSample: false }],
    ["a wanted ad created before watch_from, no product named", { ...base, match: wanted, product: null, itemCreationAt: new Date("2026-10-21T07:59:59Z") }, { outcome: "wanted_ad", makeCandidate: false, priceSample: false }],
    ["a paused product's listing seen again after the resume", { ...base, ...seen("product_paused") }, { outcome: "candidate", makeCandidate: true, priceSample: false }],
    ["a Release 0 outcome v2 does not know, seen again in band", { ...base, ...seen("segment_off") }, { outcome: "candidate", makeCandidate: true, priceSample: false }],
  ] satisfies [string, SightingInput, SightingDecision][])("%s", (_name, input, expected) => {
    expect(decideSighting(input)).toEqual(expected);
  });
});

describe("searchPollDue (spec 9)", () => {
  // 12:00 CEST, inside the day interval.
  const noon = new Date("2026-10-21T10:00:00Z");
  const search = { enabled: true, retired: false, dayIntervalS: 300, nightIntervalS: 600 };

  const ago = (ms: number): Date => new Date(noon.getTime() - ms);
  const run = (status: RunRow["status"], startedAt: Date): RunRow => ({
    status,
    startedAt,
    finishedAt: status === "running" ? null : startedAt,
  });

  it("is due for a search that never polled", () => {
    expect(searchPollDue(search, [], noon)).toEqual({ due: true });
  });

  it("is not due while the search is disabled (paused members only) or retired", () => {
    expect(searchPollDue({ ...search, enabled: false }, [], noon)).toEqual({ due: false, reason: "paused" });
    expect(searchPollDue({ ...search, retired: true }, [], noon)).toEqual({ due: false, reason: "paused" });
  });

  it("waits for the day interval less the tick slack", () => {
    expect(searchPollDue(search, [run("ok", ago(279_999))], noon)).toEqual({ due: false, reason: "interval" });
    expect(searchPollDue(search, [run("ok", ago(280_000))], noon)).toEqual({ due: true });
  });

  it("uses the night interval from 23:00 to 07:00 Berlin time", () => {
    // 02:00 CEST.
    const night = new Date("2026-10-21T00:00:00Z");
    const before = (ms: number) => new Date(night.getTime() - ms);
    expect(searchPollDue(search, [run("ok", before(300_000))], night)).toEqual({ due: false, reason: "interval" });
    expect(searchPollDue(search, [run("ok", before(580_000))], night)).toEqual({ due: true });
  });

  it("is not due while a run is running, until that row is stale", () => {
    expect(searchPollDue(search, [run("running", ago(5 * 60_000))], noon)).toEqual({ due: false, reason: "running" });
    expect(searchPollDue(search, [run("running", ago(5 * 60_000 + 1))], noon)).toEqual({ due: true });
  });

  it("pauses for 15 minutes after 5 failed runs in a row", () => {
    const failed = [1, 2, 3, 4, 5].map((minutes) => run("error", ago(minutes * 60_000)));
    expect(searchPollDue(search, failed, noon)).toEqual({ due: false, reason: "breaker" });
    expect(searchPollDue(search, failed, new Date(ago(60_000).getTime() + 15 * 60_000))).toEqual({ due: true });
  });
});

describe("productSweepDue (spec 5.1)", () => {
  // 12:17 CEST, minute 17.
  const now = new Date("2026-10-21T10:17:00Z");
  const product: SweepProduct = { status: "active", ebayEnabled: true, priceDropCheck: true, sweepMinute: 17 };

  it("is due in the product's minute when it never swept, and not in another minute", () => {
    expect(productSweepDue(product, [], now)).toEqual({ due: true });
    expect(productSweepDue({ ...product, sweepMinute: 18 }, [], now)).toEqual({ due: false, reason: "slot" });
  });

  it.each([
    ["paused", { ...product, status: "paused" as const }],
    ["a draft", { ...product, status: "draft" as const }],
    ["archived", { ...product, status: "archived" as const }],
    ["without its eBay source", { ...product, ebayEnabled: false }],
    ["without the price-drop check", { ...product, priceDropCheck: false }],
  ])("is not due for a product %s", (_name, input) => {
    expect(productSweepDue(input, [], now)).toEqual({ due: false, reason: "off" });
  });

  it("waits 55 minutes after the last sweep started, and while one runs", () => {
    const ago = (ms: number): Date => new Date(now.getTime() - ms);
    const finished = (startedMsAgo: number): RunRow => ({ status: "ok", startedAt: ago(startedMsAgo), finishedAt: ago(startedMsAgo - 1_000) });
    expect(productSweepDue(product, [finished(55 * 60_000 - 1)], now)).toEqual({ due: false, reason: "interval" });
    expect(productSweepDue(product, [finished(55 * 60_000)], now)).toEqual({ due: true });
    expect(productSweepDue(product, [{ status: "running", startedAt: ago(60_000), finishedAt: null }], now)).toEqual({
      due: false,
      reason: "running",
    });
  });
});
