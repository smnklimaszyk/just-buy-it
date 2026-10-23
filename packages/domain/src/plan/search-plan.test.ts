import { describe, expect, it } from "vitest";
import { pickSweepMinute, planSearches, sweepSearch, type PlanProduct } from "./search-plan.js";

let counter = 0;

// A product as the planner reads it: an active road bike in category 177831 unless changed.
function product(overrides: Partial<PlanProduct> = {}): PlanProduct {
  counter += 1;
  return {
    id: `0190f0e2-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    key: `p_bike${String(counter).padStart(6, "0")}`,
    status: "active",
    ebayEnabled: true,
    categoryId: "177831",
    conditionIds: ["3000"],
    searchWords: ["rennrad"],
    speed: "normal",
    priceDropCheck: false,
    perGb: false,
    unitMinTotal: null,
    unitMaxTotal: null,
    maxCents: 80_000,
    floorCents: null,
    priceMode: "fixed",
    readCeilingCents: null,
    ...overrides,
  };
}

describe("planSearches", () => {
  it("packs the products of one category into one search with the union of their rules", () => {
    const road = product({ searchWords: ["rennrad", "roadbike"], conditionIds: ["3000"], maxCents: 80_000 });
    const gravel = product({
      searchWords: ["gravelbike", "rennrad"],
      conditionIds: ["1000", "3000"],
      speed: "fast",
      maxCents: 150_000,
      floorCents: 20_000,
    });
    expect(planSearches([road, gravel], [], 1)).toEqual({
      searches: [
        {
          id: "s1",
          categoryId: "177831",
          conditionIds: ["1000", "3000"],
          q: "(gravelbike,rennrad,roadbike)",
          // Lowest floor: the gravel bike's EUR 200 against 40 % of EUR 800.
          floorEur: 200,
          // Highest read ceiling: 2 x EUR 1,500.
          ceilingEur: 3000,
          dayIntervalS: 120,
          nightIntervalS: 600,
          enabled: true,
          productIds: [road.id, gravel.id].sort(),
          membersHash: [road.id, gravel.id].sort().join(","),
        },
      ],
      retire: [],
      nextSearchNumber: 2,
    });
  });

  it("reads a market-mode product from 10 % of its cap, so listings under a market limit far below the cap are polled", () => {
    // Cap EUR 1,000: a market value of EUR 400 at 15 % below gives a limit of EUR 340 and a floor of EUR 160.
    const lens = product({ searchWords: ["objektiv"], maxCents: 100_000, priceMode: "below_market" });

    expect(planSearches([lens], [], 1).searches.map((search) => [search.floorEur, search.ceilingEur])).toEqual([[100, 2000]]);
  });

  it("leaves out drafts, archived products and disabled eBay sources, and keeps paused ones", () => {
    const paused = product({ status: "paused", categoryId: "1" });
    const plan = planSearches(
      [
        product({ status: "draft" }),
        product({ status: "archived" }),
        product({ ebayEnabled: false }),
        paused,
      ],
      [],
      1,
    );
    expect(plan.searches.map((search) => [search.categoryId, search.productIds, search.enabled])).toEqual([
      ["1", [paused.id], false],
    ]);
  });

  it("starts a second search when the words would not fit the 100-character query", () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((letter) => product({ searchWords: [letter.repeat(30)] }));
    const plan = planSearches([d, c, b, a].filter((p) => p !== undefined), [], 1);
    expect(plan.searches.map((search) => search.q)).toEqual([
      `(${"a".repeat(30)},${"b".repeat(30)},${"c".repeat(30)})`,
      "d".repeat(30),
    ]);
    expect(plan.searches.every((search) => search.q.length <= 100)).toBe(true);
    // Words shared with a search already planned take no room.
    const shared = product({ searchWords: ["a".repeat(30), "b".repeat(30)] });
    expect(planSearches([a, b, c, shared].filter((p) => p !== undefined), [], 1).searches).toHaveLength(1);
  });

  it("splits when the cheapest floor is below 5 % of the dearest read ceiling", () => {
    // Read ceiling 2 x EUR 2,000 = EUR 4,000; 5 % of it is EUR 200.
    const frame = product({ searchWords: ["rahmen"], maxCents: 200_000 });
    const atFive = product({ searchWords: ["laufrad"], maxCents: 100_000, floorCents: 20_000 });
    const below = product({ searchWords: ["sattel"], maxCents: 100_000, floorCents: 19_999 });
    expect(planSearches([frame, atFive], [], 1).searches).toHaveLength(1);
    const split = planSearches([frame, atFive, below], [], 1).searches;
    expect(split.map((search) => search.productIds)).toEqual([[frame.id, atFive.id].sort(), [below.id]]);
    expect(split.map((search) => [search.floorEur, search.ceilingEur])).toEqual([
      [200, 4000],
      [199, 2000],
    ]);
  });

  it("keeps the live search id with the largest member overlap and retires searches left empty", () => {
    const [a, b, c] = ["1", "1", "2"].map((categoryId) => product({ categoryId }));
    const gone = product({ status: "archived", categoryId: "3" });
    const members = [a, b, c].filter((p) => p !== undefined);
    const [first, second, third] = members;
    if (!first || !second || !third) throw new Error("three products");
    const existing = [
      { id: "s4", retired: false, productIds: [first.id, second.id, third.id] },
      { id: "s7", retired: false, productIds: [third.id] },
      { id: "s9", retired: false, productIds: [gone.id] },
    ];
    const plan = planSearches([...members, gone], existing, 12);
    expect(plan.searches.map((search) => [search.id, search.productIds])).toEqual([
      ["s4", [first.id, second.id].sort()],
      ["s7", [third.id]],
    ]);
    expect(plan.retire).toEqual(["s9"]);
    expect(plan.nextSearchNumber).toBe(12);
  });

  it("gives new groups ids from the counter and never one that exists, retired ones included", () => {
    const lens = product({ categoryId: "1" });
    const bike = product({ categoryId: "2" });
    const phone = product({ categoryId: "3" });
    const existing = [
      { id: "s3", retired: true, productIds: [lens.id] },
      { id: "s5", retired: false, productIds: [bike.id] },
      { id: "s6", retired: true, productIds: [] },
    ];
    // The counter is behind the stored ids, as after a restore: s5 and s6 are skipped.
    const plan = planSearches([lens, bike, phone], existing, 5);
    expect(plan.searches.map((search) => search.id)).toEqual(["s7", "s5", "s8"]);
    expect(plan.nextSearchNumber).toBe(9);
    const again = planSearches(
      [lens, bike, phone, product({ categoryId: "4" })],
      plan.searches.map((search) => ({ id: search.id, retired: false, productIds: search.productIds })),
      plan.nextSearchNumber,
    );
    expect(again.searches.map((search) => search.id)).toEqual(["s7", "s5", "s8", "s9"]);
  });
});

describe("planSearches over random product sets", () => {
  it("puts every planned product in exactly one search that fits, whatever the input order", () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    for (let run = 0; run < 300; run++) {
      const products = Array.from({ length: 1 + Math.floor(random() * 15) }, () =>
        product({
          status: pick(["draft", "active", "paused"] as const),
          categoryId: pick(["1", "2", "3"]),
          searchWords: [`${pick(["a", "b", "c"]).repeat(1 + Math.floor(random() * 30))}`, `w${Math.floor(random() * 9)}`],
          maxCents: pick([2_000, 60_000, 300_000]),
        }),
      );
      const plan = planSearches(products, [], 1);
      const reversed = planSearches([...products].reverse(), [], 1);
      expect(reversed.searches).toEqual(plan.searches);
      const members = plan.searches.flatMap((search) => search.productIds).sort();
      const planned = products.filter((p) => p.status !== "draft").map((p) => p.id).sort();
      expect(members).toEqual(planned);
      expect(plan.searches.every((search) => search.q.length <= 100)).toBe(true);
    }
  });
});

describe("sweepSearch", () => {
  it("reads lowest floor to highest limit of the watched groups; per GB up to the largest kit", () => {
    const bike = product({ searchWords: ["rennrad", "roadbike"], conditionIds: ["1000", "3000"] });
    const limits = [
      { limitCents: 61_990, floorCents: 25_000 },
      { limitCents: 70_000, floorCents: 28_050 },
    ];
    expect(sweepSearch(bike, limits)).toEqual({
      categoryId: "177831",
      conditionIds: ["1000", "3000"],
      q: "(rennrad,roadbike)",
      floorEur: 250,
      ceilingEur: 700,
    });
    // Per GB: the floor at the minimum total, the limit at the largest kit.
    const memory = product({ perGb: true, unitMinTotal: 32, unitMaxTotal: 64, maxCents: 320 });
    const perGb = [{ limitCents: 299, floorCents: 128 }];
    expect(sweepSearch(memory, perGb)).toMatchObject({ floorEur: 40, ceilingEur: 192 });
    expect(sweepSearch({ ...memory, unitMaxTotal: 128 }, perGb).ceilingEur).toBe(383);
  });
});

describe("pickSweepMinute", () => {
  it("picks the minute with the fewest sweeps, the earliest on a tie", () => {
    expect(pickSweepMinute([])).toBe(0);
    expect(pickSweepMinute([0, 1, 2])).toBe(3);
    const everyMinuteOnce = Array.from({ length: 60 }, (_, minute) => minute);
    expect(pickSweepMinute([...everyMinuteOnce, 0, 1, 7])).toBe(2);
  });
});
