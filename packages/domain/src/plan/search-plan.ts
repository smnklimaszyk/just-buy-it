import {
  MAX_QUERY_CHARS,
  planFloorCents,
  readCeilingCents,
  searchQuery,
  type ProductRules,
  type Speed,
} from "../product.js";
import type { ResolvedLimit } from "../match/price-band.js";

// Spec 5.1. Searches are derived from the products on every save and never edited by hand.

// The product fields the planner reads, with the row's id and key and whether its eBay source
// is enabled.
export type PlanProduct = Pick<
  ProductRules,
  | "status"
  | "categoryId"
  | "conditionIds"
  | "searchWords"
  | "speed"
  | "priceDropCheck"
  | "perGb"
  | "unitMinTotal"
  | "unitMaxTotal"
  | "maxCents"
  | "floorCents"
  | "priceMode"
  | "readCeilingCents"
> & { id: string; key: string; ebayEnabled: boolean };

// An app.search row with its members from app.search_product.
export type ExistingSearch = { id: string; retired: boolean; productIds: readonly string[] };

export type PlannedSearch = {
  id: string;
  categoryId: string;
  conditionIds: string[];
  q: string;
  floorEur: number;
  ceilingEur: number;
  dayIntervalS: number;
  nightIntervalS: number;
  // At least one member is active; a search of paused members stays planned but does not poll.
  enabled: boolean;
  productIds: string[];
  // The sorted member ids, short enough to store whole.
  membersHash: string;
};

// `retire`: live searches left without members. `nextSearchNumber`: the counter after the new
// ids were taken; the store moves app.search_id_seq to it.
export type SearchPlan = { searches: PlannedSearch[]; retire: string[]; nextSearchNumber: number };

// Code presets (ADR 0037): day and night poll intervals per speed.
export const SPEED_INTERVALS: Readonly<Record<Speed, { dayIntervalS: number; nightIntervalS: number }>> = {
  fast: { dayIntervalS: 120, nightIntervalS: 600 },
  normal: { dayIntervalS: 300, nightIntervalS: 600 },
  slow: { dayIntervalS: 900, nightIntervalS: 1800 },
};

const SPEED_ORDER: readonly Speed[] = ["fast", "normal", "slow"];

// Spec 5.1 step 1: active and paused products with an enabled eBay source.
export const isPlanned = (product: Pick<PlanProduct, "status" | "ebayEnabled">): boolean =>
  product.ebayEnabled && (product.status === "active" || product.status === "paused");

function toSearch(id: string, members: readonly PlanProduct[]): PlannedSearch {
  const productIds = members.map((member) => member.id).sort();
  const speed = SPEED_ORDER.find((option) => members.some((member) => member.speed === option)) ?? "normal";
  return {
    id,
    categoryId: members[0]?.categoryId ?? "",
    conditionIds: [...new Set(members.flatMap((member) => member.conditionIds))].sort(),
    q: searchQuery(wordsOf(members)),
    floorEur: Math.floor(Math.min(...members.map(planFloorCents)) / 100),
    ceilingEur: Math.ceil(Math.max(...members.map(readCeilingCents)) / 100),
    ...SPEED_INTERVALS[speed],
    enabled: members.some((member) => member.status === "active"),
    productIds,
    membersHash: productIds.join(","),
  };
}

export function planSearches(
  products: readonly PlanProduct[],
  existing: readonly ExistingSearch[],
  nextSearchNumber: number,
): SearchPlan {
  const byCategory = new Map<string, PlanProduct[]>();
  // Paused products count, so resuming one never fails the plan.
  for (const product of products.filter(isPlanned)) {
    byCategory.set(product.categoryId, [...(byCategory.get(product.categoryId) ?? []), product]);
  }
  const groups = [...byCategory.keys()].sort().flatMap((category) => pack(byCategory.get(category) ?? []));
  const kept = keepIds(groups, existing);
  // Ids are never reused, so a new search never inherits seen items or breaker history. The
  // counter can be behind the stored ids (a restore, a hand-written row): those are skipped.
  const stored = new Set(existing.map((search) => search.id));
  let next = nextSearchNumber;
  const newId = (): string => {
    while (stored.has(`s${next}`)) next += 1;
    return `s${next++}`;
  };
  const searches = groups.map((members, at) => toSearch(kept.get(at) ?? newId(), members));
  const used = new Set(kept.values());
  const retire = existing.filter((search) => !search.retired && !used.has(search.id)).map((search) => search.id);
  return { searches, retire, nextSearchNumber: next };
}

// Spec 2.1: a new product's sweep_minute is the minute with the fewest sweeps, so the hourly
// sweeps spread over the hour. `taken` holds the other products' minutes.
export function pickSweepMinute(taken: readonly number[]): number {
  const counts = Array.from({ length: 60 }, (_, minute) => taken.filter((t) => t === minute).length);
  return counts.indexOf(Math.min(...counts));
}

export type SweepSearch = Pick<PlannedSearch, "categoryId" | "conditionIds" | "q" | "floorEur" | "ceilingEur">;

// Spec 5.1: the hourly price-sorted sweep stays per product. Its band runs from the lowest floor
// to the highest limit of the product's watched condition groups (resolved by market/limit.ts);
// per GB from the floor at the minimum total to the limit at the largest kit.
export function sweepSearch(product: PlanProduct, limits: readonly ResolvedLimit[]): SweepSearch {
  const lowUnits = product.perGb ? (product.unitMinTotal ?? 1) : 1;
  const highUnits = product.perGb ? (product.unitMaxTotal ?? 1) : 1;
  return {
    categoryId: product.categoryId,
    conditionIds: [...product.conditionIds].sort(),
    q: searchQuery(wordsOf([product])),
    floorEur: Math.floor((Math.min(...limits.map((limit) => limit.floorCents)) * lowUnits) / 100),
    ceilingEur: Math.ceil((Math.max(...limits.map((limit) => limit.limitCents)) * highUnits) / 100),
  };
}

const idNumber = (id: string): number => Number(id.slice(1));

// Spec 5.1 step 6: each group keeps the live search id it shares the most members with, largest
// overlap first, ties to the older id. Retired ids never come back.
function keepIds(groups: readonly PlanProduct[][], existing: readonly ExistingSearch[]): Map<number, string> {
  const pairs = groups.flatMap((members, at) =>
    existing
      .filter((search) => !search.retired)
      .map((search) => ({ at, id: search.id, overlap: members.filter((m) => search.productIds.includes(m.id)).length }))
      .filter((pair) => pair.overlap > 0),
  );
  pairs.sort((x, y) => y.overlap - x.overlap || idNumber(x.id) - idNumber(y.id) || x.at - y.at);
  const kept = new Map<number, string>();
  const taken = new Set<string>();
  for (const pair of pairs) {
    if (kept.has(pair.at) || taken.has(pair.id)) continue;
    kept.set(pair.at, pair.id);
    taken.add(pair.id);
  }
  return kept;
}

const wordsOf = (members: readonly PlanProduct[]): string[] =>
  [...new Set(members.flatMap((member) => member.searchWords))].sort();

// Spec 5.1 step 4: a EUR 30 part next to a EUR 2,000 item fills the pages with cheap junk.
export const PRICE_GAP_PCT = 5;

// The words fit one query and the cheapest floor is at least 5 % of the dearest read ceiling.
function fits(members: readonly PlanProduct[]): boolean {
  if (searchQuery(wordsOf(members)).length > MAX_QUERY_CHARS) return false;
  const floor = Math.min(...members.map(planFloorCents));
  const ceiling = Math.max(...members.map(readCeilingCents));
  return floor * 100 >= ceiling * PRICE_GAP_PCT;
}

// Spec 5.1 steps 3 and 4: first fit, dearest read ceiling first, then by key, so the same products
// always give the same searches. A product's words always fit one query (the product schema
// checks it), so a product is never split.
function pack(products: readonly PlanProduct[]): PlanProduct[][] {
  const ordered = [...products].sort(
    (a, b) => readCeilingCents(b) - readCeilingCents(a) || a.key.localeCompare(b.key),
  );
  const bins: PlanProduct[][] = [];
  for (const product of ordered) {
    const bin = bins.find((members) => fits([...members, product]));
    if (bin) bin.push(product);
    else bins.push([product]);
  }
  return bins;
}
