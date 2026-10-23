import { conditionGroupOf, type ConditionGroup } from "./condition-groups.js";
import { entryHits, entryMatchesAt, isNegatedAt, parseEntry, tokenize, type Entry } from "./entries.js";
import { listingFlags, type MatchFlag } from "./flags.js";
import { junkReason, type JunkReason } from "./junk.js";
import { checkLimitBand, type ResolvedLimit } from "./price-band.js";
import { unitTotalFromAspects, unitTotalFromTitle, type ItemAspect } from "./unit-total.js";

// The product fields the matcher reads (section 2.1), in camel case. Word lists hold folded
// entries in the grammar of section 3.2.
export type MatchRules = {
  key: string;
  conditionIds: readonly string[];
  mustWords: readonly (readonly string[])[];
  excludeWords: readonly string[];
  warnWords: readonly string[];
  useDefaultJunk: boolean;
  junkExceptions: readonly string[];
  accessoryCheck: boolean;
  perGb: boolean;
  unitMinTotal: number | null;
};

// A product with its limits already resolved per condition group (market/limit.ts), so the
// matcher stays pure. Per GB when `perGb`.
export type MatchProduct = MatchRules & { limits: Readonly<Partial<Record<ConditionGroup, ResolvedLimit>>> };

export type MatchSettings = { lowFeedbackBelow: number };

// The listing fields the matcher reads. A ListingCandidate fits this shape; `currency` is only
// set by sources that do not refuse other currencies before the matcher.
export type MatchListingInput = {
  title: string;
  currency?: string | undefined;
  priceCents: number;
  landedCents: number | null;
  shippingKnown: boolean;
  buyingOptions: readonly string[];
  itemGroup: boolean;
  conditionId: string | null;
  conditionText: string | null;
  seller: { feedbackScore: number | null };
};

export const LISTING_REASONS = ["no_title", "not_eur", "auction", "item_group", "defective"] as const;
export type ListingReason = (typeof LISTING_REASONS)[number];

export const PRODUCT_REASONS = [
  "wrong_condition",
  "missing_word",
  "excluded_word",
  "accessory",
  "multiple_items",
  "capacity_unknown",
  "too_small",
  "below_floor",
  "above_max",
] as const;
export type ProductReason = (typeof PRODUCT_REASONS)[number];

export type MatchReason = ListingReason | JunkReason | ProductReason;
export type MatchOutcome = "candidate" | MatchReason;

export type MatchResult = {
  // The product the outcome belongs to. Set once a product's condition, junk and must checks
  // passed, so a rejection names the product the listing is about; null before that.
  productKey: string | null;
  outcome: MatchOutcome;
  flags: MatchFlag[];
  unitTotal: number | null;
  conditionGroup: ConditionGroup | null;
  // More than one product matched (poll_run counts these).
  ambiguous: boolean;
};

const CONNECTORS = ["für", "fuer", "for", "passend", "kompatibel", "compatible"].map(parseEntry);
// "für Canon EF 50mm": a brand or series often stands between the connector and the must word,
// so the connector counts up to three tokens before it.
const CONNECTOR_REACH = 3;
const QUANTITY_WORDS = ["stück", "stk"];
const MULTIPLIER = /^(\d+)x$/;
const NUMBER = /^\d+$/;
// Tokens between the multiplier and the must word ("2x Canyon Rennrad").
const QUANTITY_REACH = 2;

type Parsed = { must: Entry[][]; exclude: Entry[] };

function parseRules(rules: MatchRules): Parsed {
  return { must: rules.mustWords.map((group) => group.map(parseEntry)), exclude: rules.excludeWords.map(parseEntry) };
}

function firstHit(tokens: readonly string[], entries: readonly Entry[]): number | null {
  const hits = entries.flatMap((entry) => entryHits(tokens, entry));
  return hits.length === 0 ? null : Math.min(...hits);
}

function excluded(tokens: readonly string[], entries: readonly Entry[]): boolean {
  return entries.some((entry) => entryHits(tokens, entry).some((at) => !(entry.negatable && isNegatedAt(tokens, at))));
}

function isAccessory(tokens: readonly string[], firstMust: number): boolean {
  for (let back = 1; back <= CONNECTOR_REACH; back++) {
    const at = firstMust - back;
    if (at >= 0 && CONNECTORS.some((connector) => entryMatchesAt(tokens, at, connector))) return true;
  }
  return false;
}

function count(token: string | undefined, pattern: RegExp): number {
  const match = token === undefined ? null : pattern.exec(token);
  return match ? Number(match[1] ?? match[0]) : 0;
}

// "2x Rennrad", "2 x Canyon Rennrad", "3 Stück": n >= 2 items in one listing.
function isMultiple(tokens: readonly string[], mustAt: ReadonlySet<number>): boolean {
  const mustWithin = (from: number) => [...Array(QUANTITY_REACH).keys()].some((offset) => mustAt.has(from + offset));
  for (let i = 0; i < tokens.length; i++) {
    if (count(tokens[i], MULTIPLIER) >= 2 && mustWithin(i + 1)) return true;
    if (count(tokens[i], NUMBER) < 2) continue;
    const next = tokens[i + 1];
    if (next === "x" && mustWithin(i + 2)) return true;
    if (next !== undefined && QUANTITY_WORDS.includes(next)) return true;
  }
  return false;
}

// The text a rule set looks at. The title carries the words; the junk rules also read the
// condition fields.
type ListingText = { titleTokens: string[]; junkRuns: string[][]; conditionId: string | null };

type RulesCheck = { outcome: "passed" | MatchReason; passed: number; unitTotal: number | null };

// Steps 1 to 6 of section 3.4 for one product. `passed` counts the steps passed, for picking
// the closest product when none matches.
function checkRules(text: ListingText, rules: MatchRules, unitTotalOf: () => number | null): RulesCheck {
  const fail = (outcome: MatchReason, passed: number, unitTotal: number | null = null): RulesCheck => ({
    outcome,
    passed,
    unitTotal,
  });
  if (text.conditionId === null || !rules.conditionIds.includes(text.conditionId)) return fail("wrong_condition", 0);
  if (rules.useDefaultJunk) {
    const junk = junkReason(text.junkRuns, rules.junkExceptions);
    if (junk) return fail(junk, 1);
  }
  const parsed = parseRules(rules);
  const tokens = text.titleTokens;
  const groupHits = parsed.must.map((group) => firstHit(tokens, group));
  if (groupHits.length === 0 || groupHits.some((hit) => hit === null)) return fail("missing_word", 2);
  if (excluded(tokens, parsed.exclude)) return fail("excluded_word", 3);
  const firstMust = Math.min(...groupHits.map((hit) => hit ?? Number.POSITIVE_INFINITY));
  if (rules.accessoryCheck && isAccessory(tokens, firstMust)) return fail("accessory", 4);
  if (!rules.perGb) {
    const mustAt = new Set(parsed.must.flat().flatMap((entry) => entryHits(tokens, entry)));
    if (isMultiple(tokens, mustAt)) return fail("multiple_items", 4);
    return { outcome: "passed", passed: 6, unitTotal: null };
  }
  const unitTotal = unitTotalOf();
  if (unitTotal === null) return fail("capacity_unknown", 5);
  if (unitTotal < (rules.unitMinTotal ?? 0)) return fail("too_small", 5, unitTotal);
  return { outcome: "passed", passed: 6, unitTotal };
}

function limitOf(product: MatchProduct, group: ConditionGroup | null): ResolvedLimit {
  const limit = group === null ? undefined : product.limits[group];
  if (!limit) throw new Error(`no resolved limit for product ${product.key}, condition group ${String(group)}`);
  return limit;
}

function listingReason(listing: MatchListingInput, titleTokens: readonly string[]): ListingReason | null {
  if (titleTokens.length === 0) return "no_title";
  if (listing.currency !== undefined && listing.currency !== "EUR") return "not_eur";
  if (!listing.buyingOptions.includes("FIXED_PRICE") && !listing.buyingOptions.includes("BEST_OFFER")) return "auction";
  if (listing.itemGroup) return "item_group";
  if (listing.conditionId === "7000") return "defective";
  return null;
}

function listingText(listing: MatchListingInput): ListingText {
  const titleTokens = tokenize(listing.title);
  return { titleTokens, junkRuns: [titleTokens, tokenize(listing.conditionText ?? "")], conditionId: listing.conditionId };
}

// The unit total is parsed only when a per-GB product asks for it, and then once.
function once(compute: () => number | null): () => number | null {
  let value: number | null | undefined;
  return () => (value === undefined ? (value = compute()) : value);
}

// Section 3.4: steps 1 to 6 pass, at any price. These listings feed the market value.
export function isQualifyingListing(listing: MatchListingInput, rules: MatchRules): boolean {
  const text = listingText(listing);
  if (listingReason(listing, text.titleTokens)) return false;
  return checkRules(text, rules, once(() => unitTotalFromTitle(listing.title))).outcome === "passed";
}

// The getItem fields the after-enrich pass reads. The item description is not among them: it
// goes to Claude, which judges it in context.
export type EnrichedListing = {
  title: string;
  conditionId: string | null;
  conditionText: string | null;
  conditionDescription: string | null;
  aspects: readonly ItemAspect[];
  priceCents: number;
  landedCents: number | null;
};

export type AfterEnrichMatch =
  | { outcome: "kept"; unitTotal: number | null; conditionGroup: ConditionGroup }
  | { outcome: "rejected"; reason: MatchReason };

// Section 3.4 after getItem: steps 1 to 6 once more on the getItem title and condition fields,
// the unit total from the title or else the capacity item specific, then the band on the
// limit resolved now for the listing's condition group.
export function matchAfterEnrich(fields: EnrichedListing, product: MatchProduct): AfterEnrichMatch {
  const reject = (reason: MatchReason): AfterEnrichMatch => ({ outcome: "rejected", reason });
  const titleTokens = tokenize(fields.title);
  if (titleTokens.length === 0) return reject("no_title");
  if (fields.conditionId === "7000") return reject("defective");
  const text: ListingText = {
    titleTokens,
    junkRuns: [titleTokens, tokenize(fields.conditionText ?? ""), tokenize(fields.conditionDescription ?? "")],
    conditionId: fields.conditionId,
  };
  const check = checkRules(text, product, once(() => unitTotalFromTitle(fields.title) ?? unitTotalFromAspects(fields.aspects)));
  if (check.outcome !== "passed") return reject(check.outcome);
  const conditionGroup = conditionGroupOf(fields.conditionId);
  if (conditionGroup === null) throw new Error(`condition ${String(fields.conditionId)} has no condition group`);
  const band = checkLimitBand(limitOf(product, conditionGroup), fields, check.unitTotal);
  if (band) return reject(band);
  return { outcome: "kept", unitTotal: check.unitTotal, conditionGroup };
}

type ProductOutcome = { product: MatchProduct; outcome: MatchOutcome; passed: number; unitTotal: number | null; totalLimit: number };

const byKey = (a: ProductOutcome, b: ProductOutcome) => (a.product.key < b.product.key ? -1 : a.product.key > b.product.key ? 1 : 0);

// Section 3.4. Several matches: the product with the most must groups, then the lowest limit,
// then the first key. None: the outcome of the product that passed the most steps (tie: first
// key). Product order never changes the result.
export function matchListing(listing: MatchListingInput, products: readonly MatchProduct[], settings: MatchSettings): MatchResult {
  const text = listingText(listing);
  const { titleTokens } = text;
  const conditionGroup = conditionGroupOf(listing.conditionId);
  const early = listingReason(listing, titleTokens);
  if (early) return { productKey: null, outcome: early, flags: [], unitTotal: null, conditionGroup, ambiguous: false };
  if (products.length === 0) throw new Error("matchListing needs at least one product");
  const unitTotalOf = once(() => unitTotalFromTitle(listing.title));

  const outcomes = products.map((product): ProductOutcome => {
    const check = checkRules(text, product, unitTotalOf);
    if (check.outcome !== "passed") return { product, outcome: check.outcome, passed: check.passed, unitTotal: check.unitTotal, totalLimit: 0 };
    const limit = limitOf(product, conditionGroup);
    const band = checkLimitBand(limit, listing, check.unitTotal);
    const totalLimit = limit.limitCents * (check.unitTotal ?? 1);
    return { product, outcome: band ?? "candidate", passed: band ? 6 : 7, unitTotal: check.unitTotal, totalLimit };
  });

  const matches = outcomes.filter((o) => o.outcome === "candidate");
  const chosen =
    matches.length > 0
      ? [...matches].sort(
          (a, b) => b.product.mustWords.length - a.product.mustWords.length || a.totalLimit - b.totalLimit || byKey(a, b),
        )[0]
      : [...outcomes].sort((a, b) => b.passed - a.passed || byKey(a, b))[0];
  if (!chosen) throw new Error("matchListing needs at least one product");
  return {
    productKey: chosen.passed >= 3 ? chosen.product.key : null,
    outcome: chosen.outcome,
    flags:
      chosen.outcome === "candidate"
        ? listingFlags({
            titleTokens,
            shippingKnown: listing.shippingKnown,
            conditionGroup,
            feedbackScore: listing.seller.feedbackScore,
            buyingOptions: listing.buyingOptions,
            warnWords: chosen.product.warnWords,
            lowFeedbackBelow: settings.lowFeedbackBelow,
          })
        : [],
    unitTotal: chosen.unitTotal,
    conditionGroup,
    ambiguous: matches.length > 1,
  };
}
