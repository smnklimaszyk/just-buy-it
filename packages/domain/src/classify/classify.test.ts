import { describe, expect, it } from "vitest";
import { GOLDEN_TITLES, type GoldenTitle } from "../../fixtures/titles.v1.js";
import type { ListingCandidate } from "../listing.js";
import type { SegmentRule } from "../rules.js";
import { startingSegmentRule } from "../rules.js";
import { SEGMENTS, type Segment } from "../segments.js";
import {
  classifyAfterEnrich,
  classifyListing,
  isQualifyingListing,
  type EnrichedFields,
  REJECT_REASONS,
  type ClassifyResult,
  type RejectReason,
} from "./classify.js";
import { foldTitle } from "./fold.js";

// Bands wide enough that only the title and listing fields decide; price rules have their own tests.
const WIDE_RULES = Object.fromEntries(
  SEGMENTS.map((s): [Segment, SegmentRule] => {
    const rule = startingSegmentRule(s);
    return [
      s,
      rule.kind === "per_item"
        ? { ...rule, floorCents: 0, maxLandedCents: 1_000_000_000 }
        : { ...rule, minCentsPerGb: 0, maxCentsPerGb: 1_000_000 },
    ];
  }),
) as Record<Segment, SegmentRule>;

function listingFor(g: GoldenTitle): ListingCandidate {
  const o = g.listing ?? {};
  const shippingKnown = o.shippingKnown ?? true;
  return {
    itemId: "v1|110000000001|0",
    legacyItemId: "110000000001",
    title: g.title,
    priceCents: 50000,
    shippingCents: shippingKnown ? 1000 : null,
    landedCents: shippingKnown ? 51000 : null,
    shippingKnown,
    buyingOptions: o.buyingOptions ?? ["FIXED_PRICE"],
    itemGroup: o.itemGroup ?? false,
    conditionId: o.conditionId ?? "3000",
    conditionText: o.conditionText ?? "Gebraucht",
    seller: { feedbackScore: o.feedbackScore ?? 100, feedbackPercent: 100, accountType: "private" },
    categoryIds: [],
    itemCreationAt: new Date("2026-10-21T09:00:00Z"),
    itemEndAt: null,
    fetchedAt: new Date("2026-10-21T10:00:00Z"),
    contentExpiresAt: new Date("2026-10-21T16:00:00Z"),
  };
}

const outcomeOf = (r: ClassifyResult) =>
  r.outcome === "candidate" ? { segment: r.segment, flags: r.flags } : { reason: r.reason };

const expectedOf = (g: GoldenTitle) =>
  "reason" in g.expected ? { reason: g.expected.reason } : { segment: g.expected.segment, flags: g.expected.flags ?? [] };

describe("price band in the classifier, starting rules", () => {
  const STARTING = Object.fromEntries(SEGMENTS.map((s) => [s, startingSegmentRule(s)])) as Record<Segment, SegmentRule>;
  const at = (title: string, feed: GoldenTitle["feed"], priceCents: number, shippingCents: number | null) => ({
    ...listingFor({ feed, title, expected: { reason: "no_title" } }),
    priceCents,
    shippingCents,
    landedCents: shippingCents === null ? null : priceCents + shippingCents,
    shippingKnown: shippingCents !== null,
  });

  it.each([
    ["RTX 3090 at the max", at("RTX 3090 Founders", "gpu", 49000, 3000), "candidate", "gpu_3090", null, true],
    ["RTX 3090 a cent above", at("RTX 3090 Founders", "gpu", 49001, 3000), "above_max", "gpu_3090", null, true],
    ["RTX 3090 below the floor", at("RTX 3090 Founders", "gpu", 20000, 999), "below_floor", "gpu_3090", null, true],
    ["RTX 3090 shipping unknown, price at the max", at("RTX 3090 Founders", "gpu", 52000, null), "candidate", "gpu_3090", null, true],
    ["DDR4 32 GB at EUR 3.20/GB", at("DDR4 32GB 2x16GB", "ram", 9740, 500), "candidate", "ram_ddr4", 32, true],
    ["DDR4 32 GB above EUR 3.20/GB", at("DDR4 32GB 2x16GB", "ram", 9741, 500), "above_max", "ram_ddr4", 32, true],
    ["DDR4 16 GB (too small)", at("DDR4 16GB", "ram", 4000, 500), "ram_too_small", "ram_ddr4", 16, false],
    ["DDR4 server RAM", at("DDR4 32GB ECC Registered", "ram", 6000, 500), "ram_server", "ram_ddr4", null, false],
    ["a wanted ad", at("Suche RTX 3090", "gpu", 40000, 0), "wanted_ad", null, null, false],
  ] as const)("%s", (_name, listing, outcome, segment, totalGb, qualifying) => {
    const result = classifyListing(listing, listing.title.startsWith("DDR") ? "ram" : "gpu", STARTING);
    expect(result.outcome === "candidate" ? "candidate" : result.reason).toBe(outcome);
    expect(result.segment).toBe(segment);
    expect(result.totalGb).toBe(totalGb);
    expect(isQualifyingListing(result)).toBe(qualifying);
  });
});

describe("classifyAfterEnrich", () => {
  const item = (title: string, extra: Partial<EnrichedFields> = {}): EnrichedFields => ({
    title,
    conditionId: "3000",
    conditionText: "Gebraucht",
    conditionDescription: null,
    aspects: [],
    ...extra,
  });
  const aspects = (pairs: Record<string, string>) => Object.entries(pairs).map(([name, value]) => ({ name, value }));
  // The worker passes the whole getItem content; the description must never change the outcome.
  const withDescription = (fields: EnrichedFields, description: string) => ({ ...fields, description });

  it.each([
    ["a clean getItem title", "gpu", "gpu_3090", item("RTX 3090 Founders Edition 24GB"), { outcome: "kept", totalGb: null }],
    ["a description saying defekt and nur OVP", "gpu", "gpu_3090", withDescription(item("RTX 3090 Founders"), "Karte defekt? Nein. Nicht nur OVP."), { outcome: "kept", totalGb: null }],
    ["a condition description with a defect", "gpu", "gpu_3090", item("RTX 3090 Founders", { conditionDescription: "Ein Lüfter defekt" }), { outcome: "rejected", reason: "defective" }],
    ["a condition description saying nicht defekt", "gpu", "gpu_3090", item("RTX 3090 Founders", { conditionDescription: "Nicht defekt, läuft" }), { outcome: "kept", totalGb: null }],
    ["a getItem title saying defektfrei", "gpu", "gpu_3090", item("RTX 3090 defektfrei, voll funktionsfähig"), { outcome: "kept", totalGb: null }],
    ["a condition text saying Artefakte keine", "gpu", "gpu_3090", item("RTX 3090 Founders", { conditionDescription: "Zustand: gebraucht, Artefakte keine" }), { outcome: "kept", totalGb: null }],
    ["a condition description saying Artefakte: keine.", "gpu", "gpu_3090", item("RTX 3090 Founders", { conditionDescription: "Artefakte: keine. Läuft stabil" }), { outcome: "kept", totalGb: null }],
    ["a condition description saying Defekt, keine Funktion", "gpu", "gpu_3090", item("RTX 3090 Founders", { conditionDescription: "Defekt, keine Funktion" }), { outcome: "rejected", reason: "defective" }],
    ["a condition description saying Defekt, kein Bild", "gpu", "gpu_3090", item("RTX 3090 Founders", { conditionDescription: "Defekt, kein Bild." }), { outcome: "rejected", reason: "defective" }],
    ["condition ID 7000", "gpu", "gpu_4090", item("RTX 4090 Founders", { conditionId: "7000" }), { outcome: "rejected", reason: "defective" }],
    ["a condition text saying box only", "gpu", "gpu_4090", item("RTX 4090 Founders", { conditionText: "Nur OVP" }), { outcome: "rejected", reason: "box_or_picture_only" }],
    ["a getItem title of another segment", "gpu", "gpu_3090", item("RTX 3090 Ti Founders"), { outcome: "rejected", reason: "wrong_model" }],
    ["a getItem title naming two models", "gpu", "gpu_4090", item("RTX 4090 statt 4080"), { outcome: "rejected", reason: "wrong_model" }],
    ["a modded card", "gpu", "gpu_4090", item("RTX 4090 48GB Mod"), { outcome: "rejected", reason: "modded" }],
    ["a wanted ad", "gpu", "gpu_4090", item("Suche RTX 4090"), { outcome: "rejected", reason: "wanted_ad" }],
    ["a PC with parts in the title", "pc", "pc_4090", item("Gaming PC RTX 4090 Netzteil Gehäuse"), { outcome: "kept", totalGb: null }],
    ["RAM with a SO-DIMM form factor", "ram", "ram_ddr4", item("DDR4 32GB 2x16GB", { aspects: aspects({ Formfaktor: "SO-DIMM" }) }), { outcome: "rejected", reason: "ram_laptop" }],
    ["RAM with a registered memory type", "ram", "ram_ddr4", item("DDR4 32GB 2x16GB", { aspects: aspects({ Speichertyp: "DDR4 SDRAM Registered" }) }), { outcome: "rejected", reason: "ram_server" }],
    ["RAM with a DIMM form factor", "ram", "ram_ddr5", item("DDR5 32GB 2x16GB", { aspects: aspects({ Formfaktor: "DIMM", Speichertyp: "DDR5 SDRAM" }) }), { outcome: "kept", totalGb: 32 }],
    ["RAM with the size only in Kapazität", "ram", "ram_ddr5", item("DDR5 6000 RGB Kit", { aspects: aspects({ "Kapazität": "64 GB" }) }), { outcome: "kept", totalGb: 64 }],
    ["RAM without any size", "ram", "ram_ddr5", item("DDR5 6000 RGB Kit", { aspects: aspects({ Farbe: "Schwarz" }) }), { outcome: "rejected", reason: "ram_capacity_unknown" }],
  ] as const)("%s", (_name, feed, segment, fields, expected) => {
    expect(classifyAfterEnrich(fields, feed, segment)).toEqual(expected);
  });
});

describe("golden titles v1", () => {
  it("has 140+ titles and a must-fire case for every title and listing reason code", () => {
    expect(GOLDEN_TITLES.length).toBeGreaterThanOrEqual(140);
    const fired = new Set(GOLDEN_TITLES.flatMap((g) => ("reason" in g.expected ? [g.expected.reason] : [])));
    const priced = new Set<RejectReason>(["not_eur", "below_floor", "above_max"]);
    expect(REJECT_REASONS.filter((r) => !priced.has(r) && !fired.has(r))).toEqual([]);
    const segments = new Set(GOLDEN_TITLES.flatMap((g) => ("segment" in g.expected ? [g.expected.segment] : [])));
    expect([...segments].sort()).toEqual([...SEGMENTS].sort());
  });

  it.each(GOLDEN_TITLES)("$feed: $title", (g) => {
    expect(outcomeOf(classifyListing(listingFor(g), g.feed, WIDE_RULES))).toEqual(expectedOf(g));
  });
});

describe("foldTitle", () => {
  it.each([
    ["lower case and collapsed spaces", "  NVIDIA   RTX 3090  ", "nvidia rtx 3090"],
    ["separators become spaces", "RTX-3090_Ti/Gaming|OC+Box", "rtx 3090 ti gaming oc box"],
    ["zero-width characters inside the model", "RTX 30​9‍0", "rtx 3090"],
    ["full-width digits and letters (NFKC)", "ＲＴＸ ３０９０", "rtx 3090"],
    ["umlauts kept, composed", "Kühler GEHÄUSE", "kühler gehäuse"],
    ["other punctuation kept", "RTX 4090, inkl. OVP (neu)", "rtx 4090, inkl. ovp (neu)"],
  ])("%s", (_name, input, expected) => {
    expect(foldTitle(input)).toBe(expected);
  });
});
