import { describe, expect, it } from "vitest";
import {
  isQualifyingListing,
  matchAfterEnrich,
  matchListing,
  type EnrichedListing,
  type MatchListingInput,
  type MatchProduct,
  type MatchRules,
} from "./match.js";

const SETTINGS = { lowFeedbackBelow: 10 };

const product = (extra: Partial<MatchProduct> = {}): MatchProduct => ({
  key: "road_bike",
  conditionIds: ["3000"],
  mustWords: [["rennrad", "road bike"]],
  excludeWords: [],
  warnWords: [],
  useDefaultJunk: true,
  junkExceptions: [],
  accessoryCheck: true,
  perGb: false,
  unitMinTotal: null,
  limits: { used: { limitCents: 80000, floorCents: 20000 } },
  ...extra,
});

const listing = (extra: Partial<MatchListingInput> = {}): MatchListingInput => ({
  title: "Rennrad 28 Zoll, Rahmenhöhe 56",
  priceCents: 50000,
  landedCents: 51000,
  shippingKnown: true,
  buyingOptions: ["FIXED_PRICE"],
  itemGroup: false,
  conditionId: "3000",
  conditionText: "Gebraucht",
  seller: { feedbackScore: 100 },
  ...extra,
});

describe("matchListing, one product, rules in the order of section 3.4", () => {
  it.each([
    ["a match", listing(), product(), "candidate"],
    ["no title", listing({ title: " ​ " }), product(), "no_title"],
    ["no title comes before not EUR", listing({ title: "", currency: "USD" }), product(), "no_title"],
    ["not EUR", listing({ currency: "USD" }), product(), "not_eur"],
    ["an auction", listing({ buyingOptions: ["AUCTION"] }), product(), "auction"],
    ["an auction with best offer", listing({ buyingOptions: ["AUCTION", "BEST_OFFER"] }), product(), "candidate"],
    ["an item group", listing({ itemGroup: true }), product(), "item_group"],
    ["condition 7000", listing({ conditionId: "7000" }), product({ conditionIds: ["3000", "7000"] }), "defective"],
    ["a condition the product does not watch", listing({ conditionId: "1000" }), product(), "wrong_condition"],
    ["no condition", listing({ conditionId: null }), product(), "wrong_condition"],
    ["a junk rule", listing({ title: "Suche Rennrad" }), product(), "wanted_ad"],
    ["a junk rule in the condition text", listing({ conditionText: "Gebraucht, defekt" }), product(), "defective"],
    ["a junk rule the product turned off", listing({ title: "Suche Rennrad" }), product({ junkExceptions: ["wanted"] }), "candidate"],
    ["no junk rules at all", listing({ title: "Rennrad defekt" }), product({ useDefaultJunk: false }), "candidate"],
    ["a must group without a match", listing({ title: "Mountainbike 29 Zoll" }), product(), "missing_word"],
    ["the second must group", listing(), product({ mustWords: [["rennrad"], ["carbon"]] }), "missing_word"],
    ["an exclude word", listing(), product({ excludeWords: ["zoll"] }), "excluded_word"],
    ["a negated ~ exclude word", listing({ title: "Rennrad, kein Sturz" }), product({ excludeWords: ["~sturz*"] }), "candidate"],
    ["a ~ exclude word", listing({ title: "Rennrad mit Sturzschaden" }), product({ excludeWords: ["~sturz*"] }), "excluded_word"],
    ["a negated plain exclude word", listing({ title: "Rennrad, kein Sturz" }), product({ excludeWords: ["sturz"] }), "excluded_word"],
    ["a connector before the first must word", listing({ title: "Sattel für Rennrad" }), product(), "accessory"],
    ["a connector before a brand and the must word", listing({ title: "Schlauch passend für Canyon Rennrad" }), product(), "accessory"],
    ["a connector after the must word", listing({ title: "Rennrad für Damen" }), product(), "candidate"],
    ["a connector four tokens before", listing({ title: "für Damen und Herren Rennrad" }), product(), "candidate"],
    ["no accessory check", listing({ title: "Sattel für Rennrad" }), product({ accessoryCheck: false }), "candidate"],
    ["2x before the must word", listing({ title: "2x Rennrad" }), product(), "multiple_items"],
    ["2 x before a brand and the must word", listing({ title: "2 x Canyon Rennrad" }), product(), "multiple_items"],
    ["3 Stück", listing({ title: "Rennrad, 3 Stück" }), product(), "multiple_items"],
    ["3 Stk", listing({ title: "Rennrad 3 Stk." }), product(), "multiple_items"],
    ["1x", listing({ title: "Rennrad 1x gefahren" }), product(), "candidate"],
    ["2x with no must word after it", listing({ title: "Rennrad 2x Flaschenhalter" }), product(), "candidate"],
    ["below the floor", listing({ priceCents: 10000, landedCents: 19999 }), product(), "below_floor"],
    ["above the limit", listing({ priceCents: 80000, landedCents: 80001 }), product(), "above_max"],
  ] as const)("%s", (_name, input, rules, outcome) => {
    expect(matchListing(input, [rules], SETTINGS).outcome).toBe(outcome);
  });
});

describe("matchListing flags", () => {
  const WARN = product({ warnWords: ["carbon", "rost*", "sturz"] });
  const open = product({ conditionIds: ["1500", "2500"], limits: { open_box: { limitCents: 80000, floorCents: 0 }, refurbished: { limitCents: 80000, floorCents: 0 } } });

  it.each([
    ["none", listing(), WARN, SETTINGS, []],
    ["untested", listing({ title: "Rennrad ungetestet" }), WARN, SETTINGS, ["untested"]],
    ["nicht getestet", listing({ title: "Rennrad nicht getestet" }), WARN, SETTINGS, ["untested"]],
    ["pickup only", listing({ title: "Rennrad nur Abholung" }), WARN, SETTINGS, ["pickup_only"]],
    ["shipping unknown", listing({ shippingKnown: false, landedCents: null }), WARN, SETTINGS, ["shipping_unknown"]],
    ["financing", listing({ title: "Rennrad, Finanzierung möglich" }), WARN, SETTINGS, ["financing"]],
    ["auf Raten", listing({ title: "Rennrad auf Raten" }), WARN, SETTINGS, ["financing"]],
    ["open box", listing({ conditionId: "1500" }), open, SETTINGS, ["open_box_or_refurbished"]],
    ["refurbished", listing({ conditionId: "2500" }), open, SETTINGS, ["open_box_or_refurbished"]],
    ["low feedback", listing({ seller: { feedbackScore: 9 } }), WARN, SETTINGS, ["low_feedback"]],
    ["feedback at the threshold", listing({ seller: { feedbackScore: 10 } }), WARN, SETTINGS, []],
    ["feedback unknown", listing({ seller: { feedbackScore: null } }), WARN, SETTINGS, []],
    ["the low-feedback setting", listing({ seller: { feedbackScore: 49 } }), WARN, { lowFeedbackBelow: 50 }, ["low_feedback"]],
    ["best offer", listing({ buyingOptions: ["FIXED_PRICE", "BEST_OFFER"] }), WARN, SETTINGS, ["best_offer"]],
    ["warn words in list order", listing({ title: "Rennrad Sturz, Carbon, Rost am Rahmen" }), WARN, SETTINGS, ["warn:carbon", "warn:rost*", "warn:sturz"]],
    [
      "listing flags first, then warn words",
      listing({ title: "Rennrad Carbon ungetestet, nur Abholung", buyingOptions: ["BEST_OFFER"], shippingKnown: false, landedCents: null }),
      WARN,
      SETTINGS,
      ["untested", "pickup_only", "shipping_unknown", "best_offer", "warn:carbon"],
    ],
    ["none on a rejection", listing({ title: "Rennrad ungetestet", landedCents: 90000 }), WARN, SETTINGS, []],
  ] as const)("%s", (_name, input, rules, settings, flags) => {
    expect(matchListing(input, [rules], settings).flags).toEqual(flags);
  });
});

describe("matchListing with several products", () => {
  const anyBike = product({ key: "any_bike", mustWords: [["rennrad", "fahrrad"]] });
  const carbon = product({ key: "carbon_bike", mustWords: [["rennrad"], ["carbon"]] });
  const cheap = product({ key: "cheap_bike", limits: { used: { limitCents: 60000, floorCents: 0 } } });
  const dear = product({ key: "dear_bike", limits: { used: { limitCents: 70000, floorCents: 0 } } });
  const twin = product({ key: "twin_bike", limits: { used: { limitCents: 60000, floorCents: 0 } } });
  const pick = (input: MatchListingInput, products: MatchProduct[]) => {
    const { productKey, outcome, ambiguous } = matchListing(input, products, SETTINGS);
    return { productKey, outcome, ambiguous };
  };

  it.each([
    ["one match", listing(), [anyBike, carbon], { productKey: "any_bike", outcome: "candidate", ambiguous: false }],
    ["most must groups", listing({ title: "Carbon Rennrad" }), [anyBike, carbon], { productKey: "carbon_bike", outcome: "candidate", ambiguous: true }],
    ["then the lowest limit", listing(), [dear, cheap], { productKey: "cheap_bike", outcome: "candidate", ambiguous: true }],
    ["then the first key", listing(), [twin, cheap], { productKey: "cheap_bike", outcome: "candidate", ambiguous: true }],
    ["a match beats a closer rejection", listing({ landedCents: 65000 }), [cheap, dear], { productKey: "dear_bike", outcome: "candidate", ambiguous: false }],
    ["none: the product that passed most steps", listing({ landedCents: 99000, title: "Rennrad ohne Carbon" }), [carbon, anyBike], { productKey: "any_bike", outcome: "above_max", ambiguous: false }],
    ["none: a tie goes to the first key", listing({ landedCents: 99000 }), [dear, cheap], { productKey: "cheap_bike", outcome: "above_max", ambiguous: false }],
    ["no product key before the must words passed", listing({ title: "Mountainbike" }), [carbon, anyBike], { productKey: null, outcome: "missing_word", ambiguous: false }],
    ["no product key for a junk rejection", listing({ title: "Suche Rennrad" }), [anyBike], { productKey: null, outcome: "wanted_ad", ambiguous: false }],
    ["a product key for an excluded word", listing(), [product({ excludeWords: ["zoll"] })], { productKey: "road_bike", outcome: "excluded_word", ambiguous: false }],
  ] as const)("%s", (_name, input, products, expected) => {
    expect(pick(input, [...products])).toEqual(expected);
  });
});

describe("isQualifyingListing", () => {
  const rules: MatchRules = product();
  const ram = { ...rules, key: "kit", mustWords: [["kit"]], perGb: true, unitMinTotal: 32 };

  it.each([
    ["a match at any price", listing({ landedCents: 9_000_000 }), rules, true],
    ["below any floor", listing({ landedCents: 1 }), rules, true],
    ["an auction", listing({ buyingOptions: ["AUCTION"] }), rules, false],
    ["a wrong condition", listing({ conditionId: "1000" }), rules, false],
    ["a junk rule", listing({ title: "Rennrad defekt" }), rules, false],
    ["a missing word", listing({ title: "Mountainbike" }), rules, false],
    ["an excluded word", listing({ title: "Rennrad Kinder" }), { ...rules, excludeWords: ["kinder"] }, false],
    ["an accessory", listing({ title: "Sattel für Rennrad" }), rules, false],
    ["per GB with a total", listing({ title: "Kit 2x16GB" }), ram, true],
    ["per GB too small", listing({ title: "Kit 2x8GB" }), ram, false],
    ["per GB without a total", listing({ title: "Kit" }), ram, false],
  ] as const)("%s", (_name, input, productRules, expected) => {
    expect(isQualifyingListing(input, productRules)).toBe(expected);
  });
});

describe("matchAfterEnrich", () => {
  const item = (extra: Partial<EnrichedListing> = {}): EnrichedListing => ({
    title: "Rennrad 28 Zoll, Rahmenhöhe 56",
    conditionId: "3000",
    conditionText: "Gebraucht",
    conditionDescription: null,
    aspects: [],
    priceCents: 50000,
    landedCents: 51000,
    ...extra,
  });
  const aspects = (pairs: Record<string, string>) => Object.entries(pairs).map(([name, value]) => ({ name, value }));
  const kit = product({
    key: "memory_kit",
    mustWords: [["kit"]],
    excludeWords: ["sodimm"],
    perGb: true,
    unitMinTotal: 32,
    limits: { used: { limitCents: 320, floorCents: 0 } },
  });
  // The worker passes the whole getItem content; the item description never changes the outcome.
  const withDescription = (fields: EnrichedListing, description: string) => ({ ...fields, description });

  it.each([
    ["a clean getItem title", item(), product(), { outcome: "kept", unitTotal: null, conditionGroup: "used" }],
    ["a description saying defekt", withDescription(item(), "Defekt? Nein. Nicht nur OVP."), product(), { outcome: "kept", unitTotal: null, conditionGroup: "used" }],
    ["a condition description with a defect", item({ conditionDescription: "Schaltung defekt" }), product(), { outcome: "rejected", reason: "defective" }],
    ["a condition description saying nicht defekt", item({ conditionDescription: "Nicht defekt, fährt gut" }), product(), { outcome: "kept", unitTotal: null, conditionGroup: "used" }],
    ["a getItem title saying defektfrei", item({ title: "Rennrad defektfrei" }), product(), { outcome: "kept", unitTotal: null, conditionGroup: "used" }],
    ["a condition description saying Defekt, keine Funktion", item({ conditionDescription: "Defekt, keine Funktion" }), product(), { outcome: "rejected", reason: "defective" }],
    ["condition 7000", item({ conditionId: "7000" }), product(), { outcome: "rejected", reason: "defective" }],
    ["a changed condition the product does not watch", item({ conditionId: "1000" }), product(), { outcome: "rejected", reason: "wrong_condition" }],
    ["a condition text saying box only", item({ conditionText: "Nur OVP" }), product(), { outcome: "rejected", reason: "box_or_picture_only" }],
    ["a getItem title without the must word", item({ title: "Mountainbike 29 Zoll" }), product(), { outcome: "rejected", reason: "missing_word" }],
    ["a getItem title with an exclude word", item({ title: "Rennrad für Kinder" }), product({ excludeWords: ["kinder"] }), { outcome: "rejected", reason: "excluded_word" }],
    ["a wanted ad", item({ title: "Suche Rennrad" }), product(), { outcome: "rejected", reason: "wanted_ad" }],
    ["an accessory", item({ title: "Sattel für Rennrad" }), product(), { outcome: "rejected", reason: "accessory" }],
    ["now above the limit", item({ landedCents: 80001 }), product(), { outcome: "rejected", reason: "above_max" }],
    ["now below the floor", item({ landedCents: 19999 }), product(), { outcome: "rejected", reason: "below_floor" }],
    ["per GB from the title", item({ title: "Kit 2x16GB", landedCents: 10240 }), kit, { outcome: "kept", unitTotal: 32, conditionGroup: "used" }],
    ["per GB from the Kapazität specific", item({ title: "Kit RGB", landedCents: 10240, aspects: aspects({ Kapazität: "32 GB" }) }), kit, { outcome: "kept", unitTotal: 32, conditionGroup: "used" }],
    ["per GB, the title before the specific", item({ title: "Kit 2x16GB", landedCents: 10240, aspects: aspects({ Kapazität: "64 GB" }) }), kit, { outcome: "kept", unitTotal: 32, conditionGroup: "used" }],
    ["per GB without any size", item({ title: "Kit RGB", aspects: aspects({ Farbe: "Schwarz" }) }), kit, { outcome: "rejected", reason: "capacity_unknown" }],
    ["per GB too small", item({ title: "Kit RGB", aspects: aspects({ Capacity: "16 GB" }) }), kit, { outcome: "rejected", reason: "too_small" }],
    ["per GB above the limit", item({ title: "Kit 2x16GB", landedCents: 10241 }), kit, { outcome: "rejected", reason: "above_max" }],
  ] as const)("%s", (_name, fields, rules, expected) => {
    expect(matchAfterEnrich(fields, rules)).toEqual(expected);
  });
});
