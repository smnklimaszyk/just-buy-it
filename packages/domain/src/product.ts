import { CONDITION_GROUPS, conditionGroupOf, type ConditionGroup } from "./match/condition-groups.js";
import { checkWordEntry, type EntryCheck, type EntryList } from "./match/entries.js";
import { isJunkRuleId } from "./match/junk.js";
import type { BuyerProfile } from "./vat.js";

// Spec 2.1. The editable fields of an app.product row, as the form, the ops CLI and the legacy
// import hand them in. The store adds key, version, match_version, sweep_minute and watch_from.
export const PRODUCT_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const PRICE_MODES = ["fixed", "below_market"] as const;
export type PriceMode = (typeof PRICE_MODES)[number];

export const SPEEDS = ["fast", "normal", "slow"] as const;
export type Speed = (typeof SPEEDS)[number];

export const BUYER_PROFILES: readonly BuyerProfile[] = ["company", "private"];

// Word lists hold folded entries in the grammar of spec 3.2. Money is integer cents, per GB
// when `perGb`.
export type ProductRules = {
  name: string;
  description: string;
  status: ProductStatus;
  categoryId: string;
  categoryName: string | null;
  conditionIds: string[];
  searchWords: string[];
  mustWords: string[][];
  excludeWords: string[];
  warnWords: string[];
  useDefaultJunk: boolean;
  junkExceptions: string[];
  accessoryCheck: boolean;
  perGb: boolean;
  unitMinTotal: number | null;
  unitMaxTotal: number | null;
  priceMode: PriceMode;
  maxCents: number;
  belowMarketPct: number | null;
  floorCents: number | null;
  readCeilingCents: number | null;
  speed: Speed;
  priceDropCheck: boolean;
  candidateCapPerDay: number;
  buyerProfile: BuyerProfile;
  claudeRequired: boolean;
  alertRecipientIds: string[];
};

// A field error in the shape the form maps onto its fields: the path of the field (with list
// positions), or [] for the product as a whole.
export type ProductIssue = { path: (string | number)[]; message: string };

export type ProductParse = { ok: true; value: ProductRules } | { ok: false; issues: ProductIssue[] };

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Reads one field after another and collects every problem, so the form can show them all.
class Reader {
  readonly issues: ProductIssue[] = [];

  constructor(private readonly input: Fields) {}

  // One message per field: the first problem found is the one the form shows.
  fail(path: (string | number)[], message: string): void {
    const key = path.join(".");
    if (this.issues.some((issue) => issue.path.join(".") === key)) return;
    this.issues.push({ path, message });
  }

  text(field: string): string {
    const value = this.input[field];
    if (typeof value !== "string") {
      this.fail([field], "Enter text.");
      return "";
    }
    return value.trim();
  }

  optionalText(field: string): string | null {
    return this.input[field] === undefined || this.input[field] === null ? null : this.text(field);
  }

  choice<T extends string>(field: string, options: readonly T[], fallback?: T): T {
    const value = this.input[field] ?? fallback;
    const found = options.find((option) => option === value);
    if (found === undefined) {
      this.fail([field], `Choose one of ${options.join(", ")}.`);
      return options[0] as T;
    }
    return found;
  }

  flag(field: string, fallback: boolean): boolean {
    const value = this.input[field] ?? fallback;
    if (typeof value !== "boolean") {
      this.fail([field], "Choose yes or no.");
      return fallback;
    }
    return value;
  }

  // A required whole number from min to max; one message for every way it can be wrong.
  range(field: string, min: number, max: number, message: string): number {
    const value = this.input[field];
    if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
    this.fail([field], message);
    return min;
  }

  optionalRange(field: string, min: number, max: number, message: string): number | null {
    return this.input[field] === undefined || this.input[field] === null ? null : this.range(field, min, max, message);
  }

  list(field: string, fallback?: readonly unknown[]): unknown[] {
    const value = this.input[field] ?? fallback;
    if (!Array.isArray(value)) {
      this.fail([field], "Enter a list.");
      return [];
    }
    return value;
  }

  // Counted after duplicates are dropped, so "E-Bike" and "e bike" count once.
  count(path: (string | number)[], count: number, min: number, max: number, noun = "entries"): void {
    if (count >= min && count <= max) return;
    this.fail(path, min === 0 ? `Enter at most ${max} ${noun}.` : `Enter ${min} to ${max} ${noun}.`);
  }

  // Each item checked on its own; the stored form drops duplicates. A refused item still counts,
  // so a list of one bad item gets only that item's error.
  checked(path: (string | number)[], raw: readonly unknown[], check: ItemCheck, min: number, max: number): string[] {
    let refused = 0;
    const kept = unique(
      raw.flatMap((item, at) => {
        const result = typeof item === "string" ? check(item) : { ok: false as const, error: "Enter text." };
        if (result.ok) return [result.folded];
        this.fail([...path, at], result.error);
        refused += 1;
        return [];
      }),
    );
    this.count(path, kept.length + refused, min, max);
    return kept;
  }

  // Word entries are checked against their list's grammar and stored folded (spec 3.2).
  entries(path: (string | number)[], list: EntryList, raw: readonly unknown[], min: number, max: number): string[] {
    return this.checked(path, raw, (entry) => checkWordEntry(list, entry), min, max);
  }
}

type ItemCheck = (item: string) => EntryCheck;

// Spec 2.1.1: the IDs of the four groups. 7000 (for parts) is never offered.
const checkConditionId: ItemCheck = (id) => {
  if (id === "7000") return { ok: false, error: "For parts (7000) is never offered." };
  if (conditionGroupOf(id) === null) {
    return { ok: false, error: "Choose an eBay condition ID of New, Open box, Refurbished or Used." };
  }
  return { ok: true, folded: id };
};

// The largest Postgres integer: every stored number fits its column.
const MAX_INT = 2_147_483_647;

const CATEGORY_ID = /^[0-9]{1,12}$/;
const MAX_CATEGORY_NAME_CHARS = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// auth.app_user ids. Whether the person is active is checked when the store saves and when
// `send` sends.
const checkUserId: ItemCheck = (id) => {
  const lower = id.toLowerCase();
  return UUID.test(lower) ? { ok: true, folded: lower } : { ok: false, error: "Choose a person from the list." };
};

const checkJunkRuleId: ItemCheck = (id) =>
  isJunkRuleId(id) ? { ok: true, folded: id } : { ok: false, error: "Choose a junk rule from the list." };

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

// Spec 4.2: the <product> element of the screening request, written by the buyer. The listing
// element stays as it is; packages/llm renders both.
export type ProductBlockFields = {
  name: string;
  description: string;
  must_contain: string[][];
  must_not_contain: string[];
  conditions: ConditionGroup[];
  min_total_gb?: number;
  limit_eur: number;
  market_value_eur?: number | null;
  market_value_eur_per_gb?: number | null;
  market_value_status?: MarketValueStatus;
};

// app.market_value.status (spec 2.4).
export type MarketValueStatus = "none" | "rough" | "ok";

// The limit the candidate passed, for the whole listing (per GB: the per-GB limit times the
// listing's total), and in market mode the value it came from (per GB when per GB). `market`
// is null when no value was used: the limit is the cap.
export type ProductBlockPrice = {
  limitCents: number;
  market: { valueCents: number; status: MarketValueStatus } | null;
};

export function productBlockFields(rules: ProductRules, price: ProductBlockPrice): ProductBlockFields {
  const groups = new Set(rules.conditionIds.map(conditionGroupOf));
  const fields: ProductBlockFields = {
    name: rules.name,
    description: rules.description,
    must_contain: rules.mustWords,
    must_not_contain: rules.excludeWords,
    conditions: CONDITION_GROUPS.filter((group) => groups.has(group)),
    ...(rules.unitMinTotal === null ? {} : { min_total_gb: rules.unitMinTotal }),
    limit_eur: price.limitCents / 100,
  };
  if (rules.priceMode !== "below_market") return fields;
  const value = price.market === null ? null : price.market.valueCents / 100;
  return {
    ...fields,
    ...(rules.perGb ? { market_value_eur_per_gb: value } : { market_value_eur: value }),
    market_value_status: price.market?.status ?? "none",
  };
}

// "<" is written as its JSON escape, so no field can close or open an element; the JSON still
// parses to the same text. Compact, because every byte counts against MAX_PRODUCT_BLOCK_BYTES.
export function renderProductBlock(fields: ProductBlockFields): string {
  return `<product>\n${JSON.stringify(fields).replaceAll("<", "\\u003c")}\n</product>`;
}

// Spec 4.2: the <product> element's own share of the screening input cap.
export const MAX_PRODUCT_BLOCK_BYTES = 2_500;

// Wider than any amount a limit or market value can have, so the measured block is never
// smaller than one a real candidate renders.
const WIDEST_CENTS = Number.MAX_SAFE_INTEGER;

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

// UTF-8 bytes of the largest block this product can render. The form shows it in the cost box.
export function worstCaseProductBlockBytes(rules: ProductRules): number {
  const market = { valueCents: WIDEST_CENTS, status: "rough" as const };
  return utf8Bytes(renderProductBlock(productBlockFields(rules, { limitCents: WIDEST_CENTS, market })));
}

const EUR_100 = 10_000;

// The poll's price ceiling for this product, a total: the stored override, else 2 x the max
// rounded up to EUR 100 (per GB: 2 x the max per GB x the largest kit), spec 2.1.
export function readCeilingCents(
  rules: Pick<ProductRules, "maxCents" | "perGb" | "unitMaxTotal" | "readCeilingCents">,
): number {
  if (rules.readCeilingCents !== null) return rules.readCeilingCents;
  const units = rules.perGb ? (rules.unitMaxTotal ?? 1) : 1;
  return Math.ceil((2 * rules.maxCents * units) / EUR_100) * EUR_100;
}

// Spec 6.4: without a stored floor, 40 % of the market value or of the max.
export const DEFAULT_FLOOR_SHARE_PCT = 40;

// In market mode the matcher's floor is 40 % of a value the planner does not know, often far below
// the cap, so the poll reads from 10 % of the cap. That is 5 % of the default read ceiling, the
// price-gap split line, so it does not split a search on its own.
export const MARKET_PLAN_FLOOR_SHARE_PCT = 10;

// The lowest price the poll reads for this product, a total: the stored floor, else 40 % of the
// max in fixed mode (spec 6.4's fallback) and 10 % of the cap in market mode; per GB at the
// minimum total.
export function planFloorCents(rules: Pick<ProductRules, "maxCents" | "floorCents" | "unitMinTotal" | "priceMode">): number {
  const share = rules.priceMode === "below_market" ? MARKET_PLAN_FLOOR_SHARE_PCT : DEFAULT_FLOOR_SHARE_PCT;
  const floor = rules.floorCents ?? Math.floor((rules.maxCents * share) / 100);
  return floor * (rules.unitMinTotal ?? 1);
}

const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const KEY_CHARS = 10;

// Spec 2.1: a new product's key is "p_" and 10 characters of [a-z2-7], 50 random bits. The
// store passes crypto.randomBytes(7) and retries with new bytes on a unique conflict.
export function productKeyFromBytes(bytes: Uint8Array): string {
  if (bytes.length < 7) throw new Error("a product key needs 7 random bytes");
  let key = "p_";
  for (let char = 0; char < KEY_CHARS; char++) {
    let index = 0;
    for (let bit = char * 5; bit < char * 5 + 5; bit++) {
      const set = ((bytes[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1;
      index = (index << 1) | set;
    }
    key += KEY_ALPHABET[index];
  }
  return key;
}

// eBay's Browse `q` takes at most 100 characters. Words in parentheses, separated by commas,
// are OR'd: "(85mm,portraitobjektiv)".
export const MAX_QUERY_CHARS = 100;

export function searchQuery(words: readonly string[]): string {
  return words.length === 1 ? (words[0] ?? "") : `(${words.join(",")})`;
}

export function parseProductRules(input: unknown): ProductParse {
  if (!isRecord(input)) return { ok: false, issues: [{ path: [], message: "Send the product fields as an object." }] };
  const read = new Reader(input);
  const maxCents = read.range("maxCents", 1, MAX_INT, "Enter a price above 0.");
  const perGb = read.flag("perGb", false);
  const unitMinTotal = perGb ? read.range("unitMinTotal", 1, MAX_INT, "Enter the minimum total size in GB.") : null;
  // The largest kit the price-drop sweep reads. Left empty: 64 GB (the MVP's SWEEP_MAX_KIT_GB),
  // or the minimum total when that is larger.
  const unitMaxTotal =
    unitMinTotal === null
      ? null
      : (read.optionalRange("unitMaxTotal", unitMinTotal, MAX_INT, "Enter a largest size of at least the minimum total.") ??
        Math.max(64, unitMinTotal));
  const value: ProductRules = {
    name: read.text("name"),
    description: read.text("description"),
    status: read.choice("status", PRODUCT_STATUSES, "draft"),
    categoryId: read.text("categoryId"),
    categoryName: read.optionalText("categoryName") || null,
    conditionIds: read.checked(["conditionIds"], read.list("conditionIds"), checkConditionId, 1, 15),
    searchWords: read.entries(["searchWords"], "search", read.list("searchWords"), 1, 8),
    mustWords: read.list("mustWords").map((group, at) => {
      if (Array.isArray(group)) return read.entries(["mustWords", at], "must", group, 1, 8);
      read.fail(["mustWords", at], "Enter a list.");
      return [];
    }),
    excludeWords: read.entries(["excludeWords"], "exclude", read.list("excludeWords", []), 0, 60),
    warnWords: read.entries(["warnWords"], "warn", read.list("warnWords", []), 0, 30),
    useDefaultJunk: read.flag("useDefaultJunk", true),
    junkExceptions: read.checked(["junkExceptions"], read.list("junkExceptions", []), checkJunkRuleId, 0, 20),
    accessoryCheck: read.flag("accessoryCheck", true),
    perGb,
    unitMinTotal,
    unitMaxTotal,
    priceMode: read.choice("priceMode", PRICE_MODES),
    maxCents,
    belowMarketPct: null,
    floorCents: read.optionalRange("floorCents", 1, maxCents, "Enter a floor above 0 and at most the max price."),
    // A total, also per GB: at least the max for the smallest qualifying listing.
    readCeilingCents: read.optionalRange(
      "readCeilingCents",
      maxCents * (unitMinTotal ?? 1),
      MAX_INT,
      "Enter a poll price ceiling of at least the max price.",
    ),
    speed: read.choice("speed", SPEEDS, "normal"),
    priceDropCheck: read.flag("priceDropCheck", false),
    // getItem and Claude per product per Berlin day. The import passes 20 (owner decision 10).
    candidateCapPerDay: read.optionalRange("candidateCapPerDay", 0, 200, "Enter 0 to 200 candidates a day.") ?? 10,
    buyerProfile: read.choice("buyerProfile", BUYER_PROFILES),
    claudeRequired: read.flag("claudeRequired", false),
    alertRecipientIds: read.checked(["alertRecipientIds"], read.list("alertRecipientIds", []), checkUserId, 0, 20),
  };
  read.count(["mustWords"], value.mustWords.length, 1, 6, "groups");
  // Name and description reach Claude inside the <product> element (spec 4.2).
  for (const [field, max] of [["name", 60], ["description", 300]] as const) {
    const chars = [...value[field]].length;
    if (chars < 1 || chars > max) read.fail([field], `Use 1 to ${max} characters.`);
    else if (value[field].includes("<")) read.fail([field], "Do not use <.");
  }
  if (!CATEGORY_ID.test(value.categoryId)) read.fail(["categoryId"], "Enter an eBay category ID of 1 to 12 digits.");
  if (value.categoryName !== null && [...value.categoryName].length > MAX_CATEGORY_NAME_CHARS) {
    read.fail(["categoryName"], `Use at most ${MAX_CATEGORY_NAME_CHARS} characters.`);
  }
  value.belowMarketPct =
    value.priceMode === "below_market" ? read.range("belowMarketPct", 1, 90, "Enter a percent from 1 to 90.") : null;
  const queryChars = searchQuery(value.searchWords).length;
  if (queryChars > MAX_QUERY_CHARS) {
    read.fail(["searchWords"], `The search words use ${queryChars} of ${MAX_QUERY_CHARS} characters of the eBay query.`);
  }
  if (read.issues.length > 0) return { ok: false, issues: read.issues };
  const blockBytes = worstCaseProductBlockBytes(value);
  if (blockBytes > MAX_PRODUCT_BLOCK_BYTES) {
    const message = `The product is too long for the Claude check: ${blockBytes.toLocaleString("en-US")} of ${MAX_PRODUCT_BLOCK_BYTES.toLocaleString("en-US")} bytes. Shorten the description or the word lists.`;
    return { ok: false, issues: [{ path: [], message }] };
  }
  return { ok: true, value };
}
