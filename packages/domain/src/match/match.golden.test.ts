import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/match-cases.v1.json" with { type: "json" };
import { CONDITION_GROUPS, type ConditionGroup } from "./condition-groups.js";
import { checkWordEntry, foldEntry, tokenize } from "./entries.js";
import { isJunkRuleId, JUNK_REASONS } from "./junk.js";
import type { ResolvedLimit } from "./price-band.js";
import {
  LISTING_REASONS,
  matchListing,
  PRODUCT_REASONS,
  type MatchListingInput,
  type MatchProduct,
  type MatchResult,
} from "./match.js";

// The fixture's shape. Assigning the imported JSON to it checks every field at compile time.
type FixtureProduct = {
  hardware: boolean;
  conditionIds?: string[];
  mustWords: string[][];
  excludeWords?: string[];
  warnWords?: string[];
  useDefaultJunk?: boolean;
  junkExceptions?: string[];
  accessoryCheck?: boolean;
  perGb?: boolean;
  unitMinTotal?: number | null;
  limitCents?: number;
  floorCents?: number;
  limits?: Partial<Record<ConditionGroup, ResolvedLimit>>;
};

type FixtureCase = {
  id: string;
  title: string;
  conditionId?: string | null;
  conditionText?: string | null;
  buyingOptions?: string[];
  priceCents?: number;
  shippingCents?: number | null;
  feedbackScore?: number | null;
  itemGroup?: boolean;
  currency?: string;
  products: string[];
  expect: {
    product: string | null;
    outcome: string;
    flags?: string[];
    unitTotal?: number | null;
    conditionGroup?: string | null;
    ambiguous?: boolean;
  };
  note?: string;
};

type Fixture = {
  productDefaults: Required<Omit<FixtureProduct, "hardware" | "mustWords" | "limits">>;
  caseDefaults: Required<Pick<FixtureCase, "conditionId" | "conditionText" | "buyingOptions" | "priceCents" | "shippingCents" | "feedbackScore" | "itemGroup">>;
  searches: Record<string, string[]>;
  products: Record<string, FixtureProduct>;
  cases: FixtureCase[];
};

const FIXTURE: Fixture = fixture;
const SETTINGS = { lowFeedbackBelow: 10 };

function productOf(key: string): MatchProduct {
  const p = FIXTURE.products[key];
  if (!p) throw new Error(`fixture product ${key} is missing`);
  const d = FIXTURE.productDefaults;
  const limitCents = p.limitCents ?? d.limitCents;
  const floorCents = p.floorCents ?? d.floorCents;
  return {
    key,
    conditionIds: p.conditionIds ?? d.conditionIds,
    mustWords: p.mustWords,
    excludeWords: p.excludeWords ?? d.excludeWords,
    warnWords: p.warnWords ?? d.warnWords,
    useDefaultJunk: p.useDefaultJunk ?? d.useDefaultJunk,
    junkExceptions: p.junkExceptions ?? d.junkExceptions,
    accessoryCheck: p.accessoryCheck ?? d.accessoryCheck,
    perGb: p.perGb ?? d.perGb,
    unitMinTotal: p.unitMinTotal === undefined ? d.unitMinTotal : p.unitMinTotal,
    limits: p.limits ?? Object.fromEntries(CONDITION_GROUPS.map((group) => [group, { limitCents, floorCents }])),
  };
}

const productKeysOf = (c: FixtureCase) => c.products.flatMap((name) => FIXTURE.searches[name] ?? [name]);
const productsOf = (c: FixtureCase) => productKeysOf(c).map(productOf);

function listingOf(c: FixtureCase): MatchListingInput {
  const d = FIXTURE.caseDefaults;
  const priceCents = c.priceCents ?? d.priceCents;
  const shippingCents = c.shippingCents === undefined ? d.shippingCents : c.shippingCents;
  return {
    title: c.title,
    currency: c.currency,
    priceCents,
    landedCents: shippingCents === null ? null : priceCents + shippingCents,
    shippingKnown: shippingCents !== null,
    buyingOptions: c.buyingOptions ?? d.buyingOptions,
    itemGroup: c.itemGroup ?? d.itemGroup,
    conditionId: c.conditionId === undefined ? d.conditionId : c.conditionId,
    conditionText: c.conditionText === undefined ? d.conditionText : c.conditionText,
    seller: { feedbackScore: c.feedbackScore === undefined ? d.feedbackScore : c.feedbackScore },
  };
}

// The expectation's fields; flags default to none, the others are compared only when given.
function actualFor(c: FixtureCase, result: MatchResult) {
  const e = c.expect;
  return {
    product: result.productKey,
    outcome: result.outcome,
    flags: result.flags,
    ...(e.unitTotal === undefined ? {} : { unitTotal: result.unitTotal }),
    ...(e.conditionGroup === undefined ? {} : { conditionGroup: result.conditionGroup }),
    ...(e.ambiguous === undefined ? {} : { ambiguous: result.ambiguous }),
  };
}

const expectedFor = (c: FixtureCase) => ({ ...c.expect, flags: c.expect.flags ?? [] });

describe("golden match cases v1", () => {
  it("is sound test data: a third non-hardware, known outcomes, words in the grammar", () => {
    const ids = FIXTURE.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const nonHardware = FIXTURE.cases.filter((c) => productKeysOf(c).every((key) => FIXTURE.products[key]?.hardware === false));
    expect(nonHardware.length * 3).toBeGreaterThanOrEqual(FIXTURE.cases.length);
    const known = new Set<string>(["candidate", ...LISTING_REASONS, ...JUNK_REASONS, ...PRODUCT_REASONS]);
    expect(FIXTURE.cases.filter((c) => !known.has(c.expect.outcome)).map((c) => c.id)).toEqual([]);
    expect([...known].filter((outcome) => !/^[a-z][a-z0-9_]{0,39}$/.test(outcome))).toEqual([]);
    expect(FIXTURE.cases.flatMap(productKeysOf).filter((key) => !(key in FIXTURE.products))).toEqual([]);
    const badWords = Object.entries(FIXTURE.products).flatMap(([key, p]) => [
      ...p.mustWords.flat().filter((w) => !checkWordEntry("must", w).ok),
      ...(p.excludeWords ?? []).filter((w) => !checkWordEntry("exclude", w).ok),
      ...(p.warnWords ?? []).filter((w) => !checkWordEntry("warn", w).ok),
      ...(p.junkExceptions ?? []).filter((id) => !isJunkRuleId(id)),
    ].map((w) => `${key}: ${w}`));
    expect(badWords).toEqual([]);
  });

  it.each(FIXTURE.cases)("$id: $title", (c) => {
    expect(actualFor(c, matchListing(listingOf(c), productsOf(c), SETTINGS))).toEqual(expectedFor(c));
  });
});

describe("grammar cases of section 3.5", () => {
  it.each([
    ["(a+)+$"],
    [".*"],
    ["["],
    ["\\d"],
    ["a".repeat(41)],
  ])("%j is refused in every list", (raw) => {
    const lists = ["search", "must", "warn", "exclude"] as const;
    expect(lists.filter((list) => checkWordEntry(list, raw).ok)).toEqual([]);
  });

  it("matches a 10,000-character title against 60 exclude words in under 5 ms", () => {
    const excludeWords = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? `wort${i}*` : i % 3 === 1 ? `~zwei wort${i}` : `wort${i}`));
    const rules = { ...productOf("road_bike"), excludeWords, warnWords: ["wort*"] };
    const filler = "aaaaaaaa wortx zwei wortz nicht ohne ";
    const title = `Rennrad ${filler.repeat(Math.ceil(10_000 / filler.length))}`.slice(0, 10_000);
    const input = { ...listingOf({ id: "long", title, products: [], expect: { product: null, outcome: "candidate" } }), title };
    const run = () => {
      const started = performance.now();
      const result = matchListing(input, [rules], SETTINGS);
      return { ms: performance.now() - started, result };
    };
    run();
    const runs = Array.from({ length: 5 }, run);
    expect(runs[0]?.result.outcome).toBe("candidate");
    expect(Math.min(...runs.map((r) => r.ms))).toBeLessThan(5);
  });
});

// Section 3.5 properties, as loops over every golden case.
describe("properties", () => {
  it("folding is idempotent", () => {
    const texts = [...FIXTURE.cases.map((c) => c.title), " ~Kein_Bild* ", "Ｇröße ​X|L", "a­b", "2×16GB"];
    expect(texts.filter((t) => foldEntry(foldEntry(t)) !== foldEntry(t))).toEqual([]);
    expect(texts.filter((t) => tokenize(tokenize(t).join(" ")).join(" ") !== tokenize(t).join(" "))).toEqual([]);
  });

  it("adding an exclude word never turns a rejection into a match", () => {
    const extra = ["~kratzer", "gaming", "pc", "ddr5", "neu*", "rennrad", "canon", "nur", "zoll"];
    const broken = FIXTURE.cases.flatMap((c) => {
      const before = matchListing(listingOf(c), productsOf(c), SETTINGS);
      return extra.flatMap((word) => {
        const products = productsOf(c).map((p) => ({ ...p, excludeWords: [...p.excludeWords, word] }));
        const after = matchListing(listingOf(c), products, SETTINGS);
        return before.outcome !== "candidate" && after.outcome === "candidate" ? [`${c.id} + ${word}`] : [];
      });
    });
    expect(broken).toEqual([]);
  });

  it("product order does not change the result", () => {
    const reorderings = (list: MatchProduct[]) => [
      [...list].reverse(),
      ...list.map((_, i) => [...list.slice(i), ...list.slice(0, i)]),
    ];
    const changed = FIXTURE.cases.flatMap((c) => {
      const before = matchListing(listingOf(c), productsOf(c), SETTINGS);
      const extended = [...productsOf(c), productOf("lens_any_canon"), productOf("espresso_for_parts")];
      const base = matchListing(listingOf(c), extended, SETTINGS);
      const all = [...reorderings(productsOf(c)).map((list) => [before, list] as const), ...reorderings(extended).map((list) => [base, list] as const)];
      return all.some(([expected, list]) => !isDeepStrictEqual(matchListing(listingOf(c), list, SETTINGS), expected)) ? [c.id] : [];
    });
    expect(changed).toEqual([]);
  });

  it("case and hidden characters do not change the result", () => {
    // Upper case only where lower-casing gives the same character back ("ß" upper-cases to "SS").
    const shout = (text: string) =>
      [...text].map((ch) => (ch.toUpperCase().toLowerCase() === ch ? ch.toUpperCase() : ch)).join("");
    const hidden = ["​", "‌", "‍", "⁠", "­", "﻿"];
    const sprinkle = (text: string) => [...text].map((ch, i) => `${ch}${hidden[i % hidden.length] ?? ""}`).join("");
    const changed = FIXTURE.cases.flatMap((c) => {
      const before = matchListing(listingOf(c), productsOf(c), SETTINGS);
      return [shout, sprinkle, (t: string) => sprinkle(shout(t))].some((change) => {
        const listing = { ...listingOf(c), title: change(c.title), conditionText: change(listingOf(c).conditionText ?? "") };
        return !isDeepStrictEqual(matchListing(listing, productsOf(c), SETTINGS), before);
      })
        ? [c.id]
        : [];
    });
    expect(changed).toEqual([]);
  });
});
