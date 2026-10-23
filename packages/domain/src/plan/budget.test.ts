import { describe, expect, it } from "vitest";
import { planDailyCalls } from "./budget.js";
import { planSearches, type PlanProduct } from "./search-plan.js";

let counter = 0;

function product(overrides: Partial<PlanProduct> = {}): PlanProduct {
  counter += 1;
  return {
    id: `0190f0e2-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    key: `p_item${String(counter).padStart(6, "0")}`,
    status: "active",
    ebayEnabled: true,
    categoryId: "3323",
    conditionIds: ["3000"],
    searchWords: [`word${counter}`],
    speed: "normal",
    priceDropCheck: true,
    perGb: false,
    unitMinTotal: null,
    unitMaxTotal: null,
    maxCents: 50_000,
    floorCents: null,
    priceMode: "fixed",
    readCeilingCents: null,
    ...overrides,
  };
}

const settings = { claudeDailyCallLimit: 40 };

// Six products in three categories, like the import: three lenses, two bikes, one coffee machine.
function sixProducts(overrides: Partial<PlanProduct> = {}): PlanProduct[] {
  return [
    ...[1, 2, 3].map(() => product({ categoryId: "3323", ...overrides })),
    ...[1, 2].map(() => product({ categoryId: "177831", ...overrides })),
    product({ categoryId: "38252", ...overrides }),
  ];
}

const total = (products: PlanProduct[], limits = settings): number =>
  planDailyCalls(planSearches(products, [], 1).searches, products, limits).total;

describe("planDailyCalls", () => {
  it("gives the worked numbers of spec 5.2", () => {
    const drafts = sixProducts({ status: "draft" });
    expect(planDailyCalls(planSearches(drafts, [], 1).searches, drafts, settings)).toEqual({
      polls: 0,
      overflow: 0,
      sweeps: 0,
      getItem: 126,
      market: 78,
      total: 204,
      ceiling: 2500,
      ok: true,
    });
    const six = sixProducts();
    expect(planDailyCalls(planSearches(six, [], 1).searches, six, settings)).toMatchObject({
      polls: 720,
      overflow: 30,
      sweeps: 144,
      getItem: 126,
      market: 78,
      total: 1098,
    });
    expect(total(sixProducts({ speed: "fast" }))).toBe(1962);
    // One more product in an existing category: +3, or +27 with the price-drop check.
    expect(total([...six, product({ categoryId: "3323", priceDropCheck: false })])).toBe(1098 + 3);
    expect(total([...six, product({ categoryId: "3323" })])).toBe(1098 + 27);
    // A new category at fast, normal, slow; +24 with the price-drop check.
    const newCategory = (speed: PlanProduct["speed"], priceDropCheck = false) =>
      total([...six, product({ categoryId: "179", speed, priceDropCheck })]) - 1098;
    expect([newCategory("fast"), newCategory("normal"), newCategory("slow")]).toEqual([541, 253, 93]);
    expect(newCategory("normal", true)).toBe(253 + 24);
    // Claude call limit 40 to 100.
    expect(total(six, { claudeDailyCallLimit: 100 }) - 1098).toBe(180);
  });

  it("never returns a plan above 2,500 as ok, over 500 random product sets", () => {
    // mulberry32: a fixed seed, so a failure can be replayed.
    let seed = 20_261_022;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    let over = 0;
    for (let run = 0; run < 500; run++) {
      const products = Array.from({ length: Math.floor(random() * 25) }, () =>
        product({
          status: pick(["draft", "active", "paused", "archived"] as const),
          ebayEnabled: random() < 0.9,
          categoryId: pick(["1", "2", "3", "4", "5", "6", "7", "8"]),
          searchWords: [pick(["alpha", "beta", "gamma", "delta"]), `w${Math.floor(random() * 40)}`],
          speed: pick(["fast", "normal", "slow"] as const),
          priceDropCheck: random() < 0.5,
          maxCents: pick([3_000, 50_000, 400_000]),
        }),
      );
      const limits = { claudeDailyCallLimit: pick([0, 40, 100, 400]) };
      const plan = planDailyCalls(planSearches(products, [], 1).searches, products, limits);
      expect(plan.total).toBe(plan.polls + plan.overflow + plan.sweeps + plan.getItem + plan.market);
      expect(plan.ok).toBe(plan.total <= 2_500);
      if (plan.total > 2_500) over += 1;
    }
    // Both sides of the ceiling were tried.
    expect(over).toBeGreaterThan(50);
    expect(over).toBeLessThan(450);
  });
});
